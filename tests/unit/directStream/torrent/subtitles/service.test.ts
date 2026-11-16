import { mkdtemp, readFile as readText, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubtitleShelf } from '../../../../../src/directStream/torrent/subtitles/disk.js';
import { chooseServiceSubtitles, openSubtitlesHash, parseServiceAnswer, serviceListUrl, serviceTier } from '../../../../../src/directStream/torrent/subtitles/service.js';
import type { SubtitleContext } from '../../../../../src/directStream/torrent/subtitles/chain.js';
import { REST_OF_CONTEXT } from './context.js';
import type { TorrentHandle } from '../../../../../src/directStream/torrent/types.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/torrent-subtitles/opensubs-sintel.json');
const HASH = 'c'.repeat(40);
const SIZE = 128 * 1024;
const SRT = (line: string): string => `1\r\n00:00:01,000 --> 00:00:30,000\r\n${line}\r\n`;

/** A file of SIZE bytes, zero but for its first word (1) and its last word (2): hash = SIZE + 3. */
function video(): Buffer {
  const b = Buffer.alloc(SIZE);
  b.writeBigUInt64LE(1n, 0);
  b.writeBigUInt64LE(2n, SIZE - 8);
  return b;
}

describe('openSubtitlesHash', () => {
  it('adds the size and the words of the first and last 64 KiB, modulo 2^64', async () => {
    const b = video();
    expect(await openSubtitlesHash(SIZE, async (s, e) => b.subarray(s, e + 1))).toBe((SIZE + 3).toString(16).padStart(16, '0'));
    const wrap = Buffer.alloc(SIZE);
    wrap.writeBigUInt64LE(0xffffffffffffffffn, 0);
    expect(await openSubtitlesHash(SIZE, async (s, e) => wrap.subarray(s, e + 1))).toBe((SIZE - 1).toString(16).padStart(16, '0'));
    expect(await openSubtitlesHash(1000, async () => Buffer.alloc(0))).toBeNull();
  });
});

describe('the service answer', () => {
  it('keeps English entries only, and orders them by hash, language in the name, then shared words', async () => {
    const list = parseServiceAnswer(JSON.parse(await readText(FIXTURE, 'utf8')));
    expect(list.map((s) => s.id)).toEqual(['3871796', '6738581', '4784578', '3863890']);
    expect(chooseServiceSubtitles(list, 'Sintel.2010.Xvid-VODO').map((s) => s.id)).toEqual(['3863890', '6738581', '3871796', '4784578']);
    expect(chooseServiceSubtitles([...list, { ...list[0]!, id: 'h1', hashMatched: true }], 'Sintel.2010.Xvid-VODO')[0]!.id).toBe('h1');
  });

  it('builds the film, episode and hash addresses', () => {
    expect(serviceListUrl('https://s.fixture', { kind: 'movie', tmdbId: 1 }, 'tt1727587', null)).toBe('https://s.fixture/subtitles/movie/tt1727587.json');
    expect(serviceListUrl('https://s.fixture', { kind: 'tv', tmdbId: 1, season: 1, episode: 2 }, 'tt0903747', { hash: '0000000000020003', size: SIZE })).toBe(
      'https://s.fixture/subtitles/series/tt0903747:1:2/videoHash=0000000000020003&videoSize=131072.json',
    );
  });
});

describe('serviceTier (R3.3)', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'notesd-service-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const handle = { read: (_i: number, r: { start: number; end: number }) => Readable.from([video().subarray(r.start, r.end + 1)]) } as unknown as TorrentHandle;
  const ctx = (over: Partial<SubtitleContext> = {}): SubtitleContext => ({
    ...REST_OF_CONTEXT,
    ref: { kind: 'movie', tmdbId: 45745 }, imdbId: 'tt1727587', infoHash: HASH, release: 'Sintel.2010.Xvid-VODO',
    files: [{ index: 0, path: 'Sintel/Sintel.mp4', name: 'Sintel.mp4', length: SIZE }], fileIndex: 0, subtitleIndexes: [], handle, cloudTried: false, ...over,
  });
  type Call = { url: string; ua: string | null };
  const fake = (answer: (url: string) => Response) => {
    const calls: Call[] = [];
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, ua: new Headers(init.headers).get('user-agent') });
      return answer(url);
    };
    return { calls, fetch };
  };
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const entry = (id: string, m: string) => ({ id, url: `https://files.fixture/${id}.srt`, lang: 'eng', m, subtitleFileName: `${id}.srt` });

  it('asks by hash first, saying it is notesd, and keeps the hash-matched file', async () => {
    const { calls, fetch } = fake((url) => (url.endsWith('.srt') ? new Response(SRT(`line ${url}`)) : json({ subtitles: [entry('222', 'i'), entry('111', 'h')] })));
    const tier = serviceTier({ baseUrl: 'https://subs.fixture', fetch, torrents: { filePath: () => null }, shelf: new SubtitleShelf(dir) });
    const found = await tier.find(ctx());
    expect(calls[0]!.url).toBe('https://subs.fixture/subtitles/movie/tt1727587/videoHash=0000000000020003&videoSize=131072.json');
    expect(calls.every((c) => /notesd/.test(c.ua ?? ''))).toBe(true);
    expect(found).toEqual([{ url: `/api/stream/torrent/${HASH}/sub/service-111.vtt`, lang: 'en', label: 'English' }]);
    expect(await readText(path.join(dir, HASH, '.notesd-subs', 'service-111.vtt'), 'utf8')).toContain('00:00:01.000 --> 00:00:30.000');
  });

  it('falls back to the IMDb id when the hash request fails', async () => {
    const { calls, fetch } = fake((url) => (url.includes('videoHash') ? json({ err: 'x' }, 500) : url.endsWith('.srt') ? new Response(SRT('by id')) : json({ subtitles: [entry('222', 'i')] })));
    const tier = serviceTier({ baseUrl: 'https://subs.fixture', fetch, torrents: { filePath: () => null }, shelf: new SubtitleShelf(dir) });
    expect(await tier.find(ctx({ ref: { kind: 'tv', tmdbId: 1, season: 1, episode: 2 }, imdbId: 'tt0903747' }))).toEqual([
      { url: `/api/stream/torrent/${HASH}/sub/service-222.vtt`, lang: 'en', label: 'English (matched by title)' },
    ]);
    expect(calls.map((c) => c.url.replace('https://subs.fixture', ''))).toEqual([
      '/subtitles/series/tt0903747:1:2/videoHash=0000000000020003&videoSize=131072.json',
      '/subtitles/series/tt0903747:1:2.json',
      'https://files.fixture/222.srt',
    ]);
  });

  it('throws when the service does not answer, answers [] when it lists nothing, asks nothing without an IMDb id', async () => {
    const down = fake(() => json({}, 503));
    await expect(serviceTier({ baseUrl: 'https://subs.fixture', fetch: down.fetch, torrents: { filePath: () => null }, shelf: new SubtitleShelf(dir) }).find(ctx())).rejects.toThrow(/did not answer/);
    const empty = fake(() => json({ subtitles: [] }));
    expect(await serviceTier({ baseUrl: 'https://subs.fixture', fetch: empty.fetch, torrents: { filePath: () => null }, shelf: new SubtitleShelf(dir) }).find(ctx())).toEqual([]);
    expect(empty.calls).toHaveLength(2);
    const none = fake(() => json({ subtitles: [] }));
    expect(await serviceTier({ baseUrl: 'https://subs.fixture', fetch: none.fetch, torrents: { filePath: () => null }, shelf: new SubtitleShelf(dir) }).find(ctx({ imdbId: null }))).toEqual([]);
    expect(none.calls).toHaveLength(0);
  });
});
