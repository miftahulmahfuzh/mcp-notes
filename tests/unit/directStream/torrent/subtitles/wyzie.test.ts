import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSubtitleTiers, type SubtitleContext } from '../../../../../src/directStream/torrent/subtitles/chain.js';
import { SubtitleShelf } from '../../../../../src/directStream/torrent/subtitles/disk.js';
import { serviceTier } from '../../../../../src/directStream/torrent/subtitles/service.js';
import { chooseWyzieSubtitles, parseWyzieAnswer, withoutSecrets, wyzieSearchUrl, type WyzieSubtitle } from '../../../../../src/directStream/torrent/subtitles/wyzie.js';
import type { TorrentStreams } from '../../../../../src/directStream/torrent/service.js';
import { REST_OF_CONTEXT } from './context.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/torrent-subtitles/wyzie-sintel.json');
const HASH = 'e'.repeat(40);
const KEY = 'wyzie-test-key';
const SRT = (line: string): string => `1\r\n00:00:01,000 --> 00:00:30,000\r\n${line}\r\n`;
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sub = (over: Partial<WyzieSubtitle>): WyzieSubtitle => ({ id: 'x', url: 'https://w.fixture/c/x', names: [], origin: null, hearingImpaired: false, downloadCount: 0, ...over });

describe('the Wyzie answer', () => {
  it('keeps English SubRip entries a person wrote: never an `ai` one, another language or another format', async () => {
    const raw = JSON.parse(await readFile(FIXTURE, 'utf8')) as Record<string, unknown>[];
    const list = parseWyzieAnswer([...raw, { ...raw[0], id: 'fr1', language: 'fr' }, { ...raw[0], id: 'ssa1', format: 'ssa' }, { ...raw[0], id: 'ftp1', url: 'ftp://w.fixture/x' }]);
    expect(list.map((s) => s.id)).toEqual(['1952537611', '1955318586', '1953329013', '1952529149']);
    expect(list[1]!.names).toEqual(['Sintel (2010)', 'Sintel (2010).eng.srt']);
    expect(() => parseWyzieAnswer({ error: 'Source temporarily offline' })).toThrow(/not a list/);
  });

  it('orders by words shared with the release, then the same origin, then not hearing-impaired, then downloads', async () => {
    const list = parseWyzieAnswer(JSON.parse(await readFile(FIXTURE, 'utf8')));
    expect(chooseWyzieSubtitles(list, 'Sintel.2010.Xvid-VODO')[0]!.id).toBe('1952529149');
    const same = { names: ['Film.2020.1080p'] };
    const picks = chooseWyzieSubtitles(
      [
        sub({ id: 'hi-web', ...same, origin: 'WEB-DL', hearingImpaired: true, downloadCount: 900 }),
        sub({ id: 'bluray', ...same, origin: 'BluRay', downloadCount: 999 }),
        sub({ id: 'web-few', ...same, origin: 'WEB-DL', downloadCount: 5 }),
        sub({ id: 'web-many', ...same, origin: 'WEB-DL', downloadCount: 50 }),
        sub({ id: 'other', names: ['Unrelated'], origin: 'WEB-DL', downloadCount: 5000 }),
      ],
      'Film.2020.1080p.WEB-DL.x264-GRP',
    );
    expect(picks.map((s) => s.id)).toEqual(['web-many', 'web-few', 'hi-web', 'bluray', 'other']);
  });

  it('builds the film and episode addresses, by IMDb id or else TMDB id', () => {
    expect(wyzieSearchUrl('https://w.fixture', { kind: 'movie', tmdbId: 45745 }, 'tt1727587', KEY, 'default')).toBe(`https://w.fixture/search?id=tt1727587&language=en&format=srt&key=${KEY}`);
    expect(wyzieSearchUrl('https://w.fixture', { kind: 'tv', tmdbId: 1396, season: 1, episode: 2 }, null, KEY, 'all')).toBe(
      `https://w.fixture/search?id=1396&language=en&format=srt&season=1&episode=2&source=all&key=${KEY}`,
    );
  });

  it('takes a key or a token out of a message', () => {
    expect(withoutSecrets(`fetch https://w.fixture/search?id=tt1&key=${KEY}&x=1 and /c/1?tok=abc.def`)).toBe('fetch https://w.fixture/search?id=tt1&key=…&x=1 and /c/1?tok=…');
  });
});

describe('serviceTier with a Wyzie key (R3.3)', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'notesd-wyzie-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = (over: Partial<SubtitleContext> = {}): SubtitleContext => ({
    ...REST_OF_CONTEXT,
    ref: { kind: 'movie', tmdbId: 45745 }, imdbId: 'tt1727587', infoHash: HASH, release: 'Sintel.2010.Xvid-VODO', files: [], fileIndex: 0, subtitleIndexes: [], handle: null, cloudTried: false, ...over,
  });
  const fake = (answer: (url: URL) => Response | Promise<Response>) => {
    const calls: { url: URL; ua: string | null }[] = [];
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      const u = new URL(url);
      calls.push({ url: u, ua: new Headers(init.headers).get('user-agent') });
      return answer(u);
    };
    return { calls, fetch };
  };
  const item = (id: string, over: Record<string, unknown> = {}) => ({ id, url: `https://w.fixture/c/${id}?tok=secret-token`, format: 'srt', language: 'en', isHearingImpaired: false, release: `rel ${id}`, releases: [], fileName: `${id}.srt`, origin: null, downloadCount: 1, ai: false, ...over });
  const addon = (u: URL): Response => (u.pathname.endsWith('.srt') ? new Response(SRT('from the add-on')) : json({ subtitles: [{ id: '222', url: 'https://files.fixture/222.srt', lang: 'eng', m: 'i' }] }));
  const tier = (fetch: (url: string, init: RequestInit) => Promise<Response>, log: string[] = [], timeoutMs?: number) =>
    serviceTier({
      baseUrl: 'https://subs.fixture',
      wyzie: { baseUrl: 'https://w.fixture', key: KEY, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
      fetch,
      torrents: { filePath: () => null },
      shelf: new SubtitleShelf(dir),
      log: (line) => void log.push(line),
    });

  it('asks Wyzie first, saying it is notesd, and serves its best English .srt without asking the add-on', async () => {
    const { calls, fetch } = fake((u) =>
      u.pathname === '/search'
        ? json([item('ai-en', { ai: true }), item('hi', { isHearingImpaired: true, release: 'Sintel.2010.Xvid-VODO' }), item('plain', { release: 'Sintel.2010.Xvid-VODO' })])
        : new Response(SRT(`wyzie ${u.pathname}`)),
    );
    const found = await tier(fetch).find(ctx());
    expect(found).toEqual([{ url: `/api/stream/torrent/${HASH}/sub/service-wyzie-plain.vtt`, lang: 'en', label: 'English (Wyzie)' }]);
    expect(calls.map((c) => `${c.url.host}${c.url.pathname}`)).toEqual(['w.fixture/search', 'w.fixture/c/plain']);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ id: 'tt1727587', language: 'en', format: 'srt', key: KEY });
    expect(calls.every((c) => /notesd/.test(c.ua ?? ''))).toBe(true);
    expect(await readFile(path.join(dir, HASH, '.notesd-subs', 'service-wyzie-plain.vtt'), 'utf8')).toContain('wyzie /c/plain');
    // What is kept names the file, never the key or the download token.
    const chosen = await readFile(path.join(dir, HASH, '.notesd-subs', 'chosen.json'), 'utf8');
    expect(chosen).not.toMatch(/secret-token|wyzie-test-key/);
  });

  it('asks every source only when the default one lists no English .srt', async () => {
    const { calls, fetch } = fake((u) => (u.pathname === '/search' ? json(u.searchParams.get('source') === 'all' ? [item('deep')] : [item('ai-en', { ai: true })]) : new Response(SRT('deep'))));
    expect((await tier(fetch).find(ctx({ ref: { kind: 'tv', tmdbId: 1396, season: 1, episode: 2 }, imdbId: 'tt0903747' })))[0]!.url).toContain('service-wyzie-deep.vtt');
    expect(calls.map((c) => c.url.search.replace(KEY, 'K'))).toEqual([
      '?id=tt0903747&language=en&format=srt&season=1&episode=2&key=K',
      '?id=tt0903747&language=en&format=srt&season=1&episode=2&source=all&key=K',
      '?tok=secret-token',
    ]);
  });

  it('goes on to the add-on when Wyzie fails, lists nothing or is late, and never logs the key', async () => {
    const log: string[] = [];
    const failing = fake((u) => (u.host === 'w.fixture' ? json({ error: 'Source temporarily offline' }, 503) : addon(u)));
    expect(await tier(failing.fetch, log).find(ctx())).toEqual([{ url: `/api/stream/torrent/${HASH}/sub/service-222.vtt`, lang: 'en', label: 'English (matched by title)' }]);
    expect(log.join('\n')).toMatch(/wyzie gave no subtitle.*HTTP 503/);

    const empty = fake((u) => (u.host === 'w.fixture' ? json([]) : addon(u)));
    expect((await tier(empty.fetch, log).find(ctx()))[0]!.url).toContain('service-222.vtt');
    expect(empty.calls.filter((c) => c.url.host === 'w.fixture')).toHaveLength(2);

    const late = fake((u) => (u.host === 'w.fixture' ? new Promise<Response>(() => undefined) : addon(u)));
    const slow = async (url: string, init: RequestInit): Promise<Response> =>
      Promise.race([late.fetch(url, init), new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error(`aborted ${url}`))))]);
    expect((await tier(slow, log, 20).find(ctx()))[0]!.url).toContain('service-222.vtt');
    expect(log.join('\n')).not.toContain(KEY);
  });

  it('throws naming both services when neither answers', async () => {
    const down = fake(() => json({}, 500));
    await expect(tier(down.fetch).find(ctx())).rejects.toThrow(/did not answer \(wyzie: .*HTTP 500; opensubtitles by IMDb id: HTTP 500\)/);
  });

  it('never asks Wyzie without a key', async () => {
    const { calls, fetch } = fake(addon);
    const none = serviceTier({ baseUrl: 'https://subs.fixture', wyzie: null, fetch, torrents: { filePath: () => null }, shelf: new SubtitleShelf(dir) });
    expect((await none.find(ctx()))[0]!.label).toBe('English (matched by title)');
    expect(calls.some((c) => c.url.pathname === '/search')).toBe(false);
  });

  it('keeps the service tier in the chain for Wyzie alone, and leaves it out with neither service', () => {
    const deps = { torrentDir: dir, torrents: { filePath: async () => null } as unknown as TorrentStreams, log: () => undefined, fetch: async () => new Response(''), lend: () => null };
    expect(buildSubtitleTiers({ ...deps, subtitleUrl: null, wyzie: { baseUrl: 'https://w.fixture', key: KEY } }).map((t) => t.name)).toEqual(['kept', 'files', 'service', 'borrow']);
    expect(buildSubtitleTiers({ ...deps, subtitleUrl: null, wyzie: null }).map((t) => t.name)).toEqual(['kept', 'files', 'borrow']);
  });
});
