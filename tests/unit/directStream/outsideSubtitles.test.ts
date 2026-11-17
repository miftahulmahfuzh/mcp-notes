import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CachePlayView } from '../../../src/directStream/cachePlay.js';
import { OUTSIDE_EMPTY_MS, OutsideSubtitles, showsEnglish, type OutsideSession } from '../../../src/directStream/outsideSubtitles.js';
import type { DirectStreamRepo } from '../../../src/directStream/repo.js';
import { DirectStreamService } from '../../../src/directStream/service.js';
import { SessionStore } from '../../../src/directStream/sessions.js';
import { TitleSubtitleShelf, titleKey } from '../../../src/directStream/titleSubtitles.js';
import { SubtitleSync, SYNCED_LABEL, readSyncOutcome, type SpeechSpan, type SyncInput, type SyncRequest } from '../../../src/directStream/torrent/subtitles/synced.js';
import type { StretchRequest } from '../../../src/directStream/torrent/subtitles/whisper.js';
import type { StreamRef } from '../../../src/directStream/types.js';
import { directStreamRoutes } from '../../../src/http/directStreamApi.js';

const FILM: StreamRef = { kind: 'movie', tmdbId: 1518204 };
const EPISODE: StreamRef = { kind: 'tv', tmdbId: 1396, season: 2, episode: 3 };
const KEY = 'wyzie-test-key';
const WYZIE = 'https://w.fixture';
const ADDON = 'https://os.fixture';
const TOK = 'https://w.fixture/c/1?tok=secret.token';
const SRT = (line: string): string => `1\r\n00:00:01,000 --> 00:00:30,000\r\n${line}\r\n`;
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ id: '1', url: TOK, format: 'srt', language: 'en', isHearingImpaired: false, release: 'Allen.2026.1080p.NF.WEB-DL', fileName: 'a.srt', downloadCount: 5, ai: false, ...over });

describe('the page shows an English subtitle by default', () => {
  it('for an English track, or a source\'s one subtitle that names no language', () => {
    expect(showsEnglish([{ lang: 'es', label: 'Spanish' }, { lang: 'en', label: '' }])).toBe(true);
    expect(showsEnglish([{ lang: null, label: 'English (CC)' }])).toBe(true);
    expect(showsEnglish([{ lang: null, label: '' }])).toBe(true);
    expect(showsEnglish([{ lang: null, label: 'Subtitle' }])).toBe(true);
    expect(showsEnglish([{ lang: null, label: '' }, { lang: null, label: '' }])).toBe(false);
    expect(showsEnglish([{ lang: 'es', label: 'Spanish' }])).toBe(false);
    expect(showsEnglish([])).toBe(false);
  });
});

describe('outside subtitles for a cloud stream', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'notesd-outside-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  interface Fakes {
    /** Wyzie's list; a function answers later (a slow service). */
    wyzie?: unknown[] | (() => Promise<Response>);
    addon?: unknown;
    noKey?: boolean;
    waitMs?: number;
    sync?: SyncRequest[];
  }

  function setup(o: Fakes = {}) {
    const shelf = new TitleSubtitleShelf(dir);
    const calls: string[] = [];
    const logs: string[] = [];
    let clock = 1_000_000;
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url.replace(/key=[^&]+/, 'key=K'));
      if (url.startsWith(`${WYZIE}/search`)) return typeof o.wyzie === 'function' ? o.wyzie() : json(o.wyzie ?? []);
      if (url === TOK) return new Response(SRT('From Wyzie.'), { status: 200 });
      if (url.startsWith(`${ADDON}/subtitles/`)) return json(o.addon ?? { subtitles: [] });
      if (url === `${ADDON}/files/9.srt`) return new Response(SRT('From the add-on.'), { status: 200 });
      return new Response('', { status: 404 });
    };
    const outside = new OutsideSubtitles({
      shelf,
      services: { baseUrl: ADDON, wyzie: o.noKey === true ? null : { baseUrl: WYZIE, key: KEY }, fetch: fetchImpl },
      sync: o.sync === undefined ? null : { start: (request) => (o.sync?.push(request), null) },
      imdbId: async (ref) => (ref.kind === 'movie' ? null : 'tt0903747'),
      ...(o.waitMs === undefined ? {} : { waitMs: o.waitMs }),
      now: () => clock,
      log: (line) => logs.push(line),
    });
    const session = (ref: StreamRef = FILM): OutsideSession => ({ ref, outside: { subtitles: [], subtitleRev: 0, stop: new AbortController() } });
    const input = (): SyncInput => ({ url: 'https://up.example/master.m3u8' });
    return { outside, shelf, calls, logs, session, input, later: (ms: number) => void (clock += ms) };
  }

  it('asks Wyzie by the TMDB id, keeps the file per title, and a later session of the title asks nothing', async () => {
    const t = setup({ wyzie: [entry({ id: 'hi', isHearingImpaired: true, downloadCount: 999 }), entry()] });
    const first = t.session();
    await t.outside.attach(first, t.input);
    const view = { url: '/api/stream/subs/movie-1518204/outside.vtt', lang: 'en', label: 'English (Wyzie)' };
    // Within the inline wait: the page reads it with the session, so nothing is bumped.
    expect(first.outside).toMatchObject({ subtitles: [view], subtitleRev: 0 });
    expect(t.calls).toEqual([`${WYZIE}/search?id=1518204&language=en&format=srt&key=K`, TOK]);
    expect(await readFile(t.shelf.file('movie-1518204', 'outside.vtt')!, 'utf8')).toContain('From Wyzie.');
    const second = t.session();
    await t.outside.attach(second, t.input);
    expect(second.outside.subtitles).toEqual([view]);
    expect(t.calls).toHaveLength(2);
    // Neither the key nor a token is kept or logged.
    const kept = (await readFile(path.join(dir, 'movie-1518204', 'chosen.json'), 'utf8')) + t.logs.join('\n');
    expect(kept).not.toContain(KEY);
    expect(kept).not.toContain('tok=');
  });

  it('falls back on the OpenSubtitles add-on by IMDb id, for an episode', async () => {
    const t = setup({ addon: { subtitles: [{ id: '9', url: `${ADDON}/files/9.srt`, lang: 'eng' }] } });
    const s = t.session(EPISODE);
    await t.outside.attach(s, t.input);
    expect(s.outside.subtitles).toEqual([{ url: '/api/stream/subs/tv-1396-s2e3/outside.vtt', lang: 'en', label: 'English (OpenSubtitles)' }]);
    expect(t.calls).toContain(`${ADDON}/subtitles/series/tt0903747:2:3.json`);
  });

  it('does not hold the play up: a slow answer arrives behind it and bumps the revision', async () => {
    let answer!: (res: Response) => void;
    const t = setup({ wyzie: () => new Promise<Response>((resolve) => (answer = resolve)), waitMs: 20 });
    const s = t.session();
    await t.outside.attach(s, t.input);
    expect(s.outside).toMatchObject({ subtitles: [], subtitleRev: 0 });
    // The page reads the session again meanwhile: still one ask.
    await t.outside.attach(s, t.input);
    expect(t.calls).toHaveLength(1);
    answer(json([entry()]));
    await expect.poll(() => s.outside.subtitleRev).toBe(1);
    expect(s.outside.subtitles[0]!.label).toBe('English (Wyzie)');
  });

  it('a title the services have nothing for is left alone for hours', async () => {
    const t = setup();
    const s = t.session();
    await t.outside.attach(s, t.input);
    expect(s.outside.subtitles).toEqual([]);
    // Wyzie's default source, then every source; the add-on is not asked without an IMDb id.
    expect(t.calls).toHaveLength(2);
    await t.outside.attach(t.session(), t.input);
    expect(t.calls).toHaveLength(2);
    t.later(OUTSIDE_EMPTY_MS + 1);
    await t.outside.attach(t.session(), t.input);
    expect(t.calls).toHaveLength(4);
  });

  it('hands the file to Wyzie Synced once per session, and the synced file becomes the title\'s', async () => {
    const requests: SyncRequest[] = [];
    const t = setup({ wyzie: [entry()], sync: requests });
    const s = t.session();
    await t.outside.attach(s, t.input);
    await t.outside.attach(s, t.input);
    await expect.poll(() => requests.length).toBe(1);
    const request = requests[0]!;
    expect(request).toMatchObject({ ref: FILM, imdbId: null, key: 'movie-1518204', durationS: null });
    expect(request.target).toBe(s.outside);
    expect(request.signal).toBe(s.outside.stop.signal);
    expect(await request.place.input()).toEqual({ url: 'https://up.example/master.m3u8' });
    expect(request.place.outcomeFile).toBe(path.join(dir, 'movie-1518204', 'synced.json'));
    const view = await request.place.save('WEBVTT\n\n00:00:01.000 --> 00:00:30.000\nIn step.\n');
    expect(view).toEqual({ url: '/api/stream/subs/movie-1518204/synced.vtt', lang: 'en', label: SYNCED_LABEL });
    // The next session of the title gets the synced file, and no sync is asked for it.
    const next = t.session();
    await t.outside.attach(next, t.input);
    expect(next.outside.subtitles).toEqual([view]);
    await new Promise((r) => setTimeout(r, 5));
    expect(requests).toHaveLength(1);
  });

  it('gives the dialogue reader the title\'s file, kept or asked for now', async () => {
    const t = setup({ wyzie: [entry()] });
    expect(await t.outside.text(FILM)).toMatchObject({ label: 'English (Wyzie)' });
    expect((await t.outside.text(FILM))?.vtt).toContain('From Wyzie.');
    expect(t.calls).toHaveLength(2);
    expect(await setup({ noKey: true }).outside.text(EPISODE)).toBeNull();
  });

  it('opens only title folders and subtitle names', () => {
    const shelf = new TitleSubtitleShelf(dir);
    expect(titleKey(EPISODE)).toBe('tv-1396-s2e3');
    expect(shelf.file('movie-550', 'outside.vtt')).toBe(path.join(dir, 'movie-550', 'outside.vtt'));
    for (const [key, name] of [['..', 'outside.vtt'], ['movie-550/..', 'x.vtt'], ['movie-550', '../chosen.json'], ['movie-550', 'chosen.json'], ['a'.repeat(40), 'outside.vtt']] as const) {
      expect(shelf.file(key, name)).toBeNull();
    }
    expect(() => shelf.dir('etc')).toThrow(RangeError);
  });
});

describe('a cloud session and its outside subtitle (the service and the routes)', () => {
  let dir = '';
  // The background Wyzie Synced write outlives the play; await it before clearing the files, or its
  // write races the rmdir (ENOTEMPTY).
  let outsideForCleanup: OutsideSubtitles | null = null;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'notesd-outside-svc-'));
    outsideForCleanup = null;
  });
  afterEach(async () => {
    await outsideForCleanup?.idle();
    await rm(dir, { recursive: true, force: true });
  });

  const source = (subtitles: unknown[]) => ({
    ok: true,
    source: { provider: 'HyperLink', manifest_url: 'https://up.example/hls/master.m3u8', manifest_kind: 'hls', headers: { referer: 'https://embed.example/', origin: 'https://embed.example', user_agent: 'UA/1' }, subtitles, best_height: 1080 },
    attempts: [{ provider: 'HyperLink', outcome: 'resolved', took_s: 1, detail: '' }],
  });
  const CACHE = '0b6c7a52-6a0e-4d1e-9d8e-1f2a3b4c5d6e';
  const cacheView: CachePlayView = {
    id: CACHE, ref: FILM, host: 'host-a', state: 'ready', provider: 'HyperLink', height: 1080, manifestKind: 'hls', manifestUrl: `/api/stream/cache/${CACHE}/f/master.m3u8`, subtitles: [], audioLang: 'en', audio: null,
  };

  function setup(o: { subtitles?: unknown[]; cached?: boolean; answers?: Array<() => Response> } = {}) {
    const shelf = new TitleSubtitleShelf(dir);
    const asked: string[] = [];
    const cuts: StretchRequest[] = [];
    const answers = o.answers ?? [];
    const fetchImpl = async (url: string): Promise<Response> => {
      asked.push(url.split('?')[0]!);
      if (url.startsWith(`${WYZIE}/search`)) return json([entry()]);
      if (url === TOK) return new Response(SRT('From Wyzie.'), { status: 200 });
      if (url === `${WYZIE}/sync`) return (answers.shift() ?? (() => json({ error: 'No subtitles found' }, 404)))();
      if (url === 'https://w.fixture/c/2?tok=t') return new Response(SRT('In step now.'), { status: 200 });
      return new Response('', { status: 404 });
    };
    const sync = new SubtitleSync({
      wyzie: { baseUrl: WYZIE, key: KEY },
      fetch: fetchImpl,
      cutter: async (request) => {
        cuts.push(request);
        return { ok: true, lengthS: request.lengthS };
      },
      detect: async (): Promise<SpeechSpan[]> => [[10, 250]],
      log: () => undefined,
    });
    const outside = new OutsideSubtitles({ shelf, services: { baseUrl: null, wyzie: { baseUrl: WYZIE, key: KEY }, fetch: fetchImpl }, sync, imdbId: async () => 'tt31416062', log: () => undefined });
    outsideForCleanup = outside;
    const svc = new DirectStreamService({
      repo: { providers: async () => [], healthFor: async () => [], recordAttempts: async () => undefined } as unknown as DirectStreamRepo,
      runner: async (args: string[]) => (args[0] === 'open' ? { ok: true } : source(o.subtitles ?? [])),
      host: 'host-a',
      seedFile: 'unused.json',
      pageBase: () => 'http://localhost:4321',
      hooks: { originalLanguage: async () => 'en' },
      caches: () => (o.cached === true ? { find: async () => cacheView, get: async () => cacheView } : null),
      outside: () => outside,
      sessions: new SessionStore(),
      log: () => undefined,
    });
    const app = new Hono();
    app.route('/', directStreamRoutes({ directStream: svc, titleSubtitles: shelf }));
    const play = async () => {
      const res = await app.request('/api/stream/play', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'movie', tmdb_id: FILM.tmdbId }) });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (await res.json()) as any;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const read = async (id: string) => (await (await app.request(`/api/stream/sessions/${id}`)).json()) as any;
    return { app, svc, shelf, asked, cuts, play, read };
  }

  const OUTSIDE = { url: '/api/stream/subs/movie-1518204/outside.vtt', lang: 'en', label: 'English (Wyzie)', format: 'vtt', source: 'request', english: true };

  it('a stream with no English subtitle plays with the outside one, as a local file, and the route serves it', async () => {
    const t = setup({ subtitles: [{ url: 'https://up.example/es.vtt', lang: 'es', label: 'Spanish' }] });
    const json_ = await t.play();
    expect(json_.session.subtitles.map((s: { label: string }) => s.label)).toEqual(['Spanish', 'English (Wyzie)']);
    expect(json_.session.subtitles[1]).toEqual(OUTSIDE);
    expect(json_.session.subtitle_rev).toBe(0);
    const file = await t.app.request(OUTSIDE.url);
    expect(file.status).toBe(200);
    expect(await file.text()).toContain('From Wyzie.');
    expect((await t.app.request('/api/stream/subs/movie-1518204/chosen.json')).status).toBe(404);
    expect((await t.app.request('/api/stream/subs/movie-1/outside.vtt')).status).toBe(404);
    // Never in the source the dialogue reader and the pass-through read.
    expect(t.svc.session(json_.session.session_id)?.source.subtitles.map((s) => s.label)).toEqual(['Spanish']);
  });

  it('a stream with an English subtitle is left as it is: nothing is asked, nothing is synced', async () => {
    const t = setup({ subtitles: [{ url: 'https://up.example/en.vtt', lang: 'en', label: 'English' }] });
    const json_ = await t.play();
    expect(json_.session.subtitles).toHaveLength(1);
    expect(t.asked).toEqual([]);
    expect(t.cuts).toEqual([]);
  });

  it('syncs it against the stream\'s audio, read with the captured headers, and the session takes the synced file', async () => {
    const t = setup({ answers: [() => json({ url: 'https://w.fixture/c/2?tok=t', offset: 1.2, fps: null, confidence: 0.9, inSync: false, subtitle: { release: 'Allen.2026.FLUX' } })] });
    const json_ = await t.play();
    const id = json_.session.session_id as string;
    await expect.poll(async () => (await t.read(id)).subtitle_rev).toBe(1);
    const now = await t.read(id);
    expect(now.subtitles).toEqual([{ ...OUTSIDE, url: '/api/stream/subs/movie-1518204/synced.vtt', label: SYNCED_LABEL }]);
    expect(t.cuts[0]).toMatchObject({ url: 'https://up.example/hls/master.m3u8', startS: 0, lengthS: 300, inputArgs: ['-user_agent', 'UA/1', '-headers', 'Referer: https://embed.example/\r\nOrigin: https://embed.example\r\n'] });
    expect(t.cuts).toHaveLength(6);
    expect(await readSyncOutcome(path.join(dir, 'movie-1518204', 'synced.json'))).toMatchObject({ state: 'done', offset_s: 1.2, covered_s: 1800 });
    expect(await (await t.app.request('/api/stream/subs/movie-1518204/synced.vtt')).text()).toContain('In step now.');
  });

  it('a sync that fails leaves the unsynced file in place', async () => {
    const t = setup();
    const json_ = await t.play();
    await expect.poll(() => readSyncOutcome(path.join(dir, 'movie-1518204', 'synced.json'))).toMatchObject({ state: 'failed', retry: false });
    expect(await t.read(json_.session.session_id)).toMatchObject({ subtitles: [OUTSIDE], subtitle_rev: 0 });
  });

  it('a play from this machine\'s stream cache gets it too, and its audio is cut from the cache\'s local playlist', async () => {
    const t = setup({ cached: true, answers: [() => json({ error: "Couldn't sync" }, 422), () => json({ error: 'Too many requests' }, 429)] });
    const json_ = await t.play();
    expect(json_.session.cached).toMatchObject({ id: CACHE });
    expect(json_.session.subtitles).toEqual([OUTSIDE]);
    await expect.poll(() => t.cuts.length).toBeGreaterThan(0);
    expect(t.cuts[0]).toMatchObject({ url: `http://localhost:4321/api/stream/cache/${CACHE}/f/master.m3u8` });
    expect(t.cuts[0]!.inputArgs).toBeUndefined();
  });

  it('the dialogue of a title whose stream has no English subtitle is read from the outside file', async () => {
    const t = setup();
    await expect(t.svc.subtitleText(FILM)).rejects.toMatchObject({ code: 'no_subtitle' });
    expect(await t.svc.subtitleText(FILM, { outside: true })).toMatchObject({ provider: 'HyperLink', label: 'English (Wyzie)' });
  });
});
