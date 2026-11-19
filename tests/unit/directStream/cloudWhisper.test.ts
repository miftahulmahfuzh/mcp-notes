import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CloudWhisper, titleCueFeeds, type TranscriptSession } from '../../../src/directStream/cloudWhisper.js';
import { OUTSIDE_EMPTY_MS, OutsideSubtitles, type OutsideSession } from '../../../src/directStream/outsideSubtitles.js';
import { TitleSubtitleShelf } from '../../../src/directStream/titleSubtitles.js';
import type { SyncInput, SyncRequest } from '../../../src/directStream/torrent/subtitles/synced.js';
import type { StretchRequest, WhisperRequest } from '../../../src/directStream/torrent/subtitles/whisper.js';
import type { StreamRef } from '../../../src/directStream/types.js';
import { directStreamRoutes } from '../../../src/http/directStreamApi.js';

/** Chasing the Moon: TMDB lists it without an IMDb id, so no subtitle service can be asked about it by one. */
const FILM: StreamRef = { kind: 'movie', tmdbId: 1356435 };
const KEY = 'movie-1356435';
const HLS = { manifest_kind: 'hls' as const, manifest_url: 'https://up.example/master.m3u8', headers: { referer: 'https://p.example/', origin: null, user_agent: 'UA' } };

describe('Whisper for a cloud stream no subtitle service covers', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'notesd-cloudwhisper-'));
  });
  /** What a test started, stopped before its folder goes. */
  const open: Array<{ close(): Promise<void> }> = [];
  const sessions: AbortController[] = [];
  afterEach(async () => {
    for (const s of sessions.splice(0)) s.abort();
    await Promise.all(open.splice(0).map((w) => w.close()));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  /** A film of `lengthS` seconds; every stretch that holds audio gives one cue that says where it was cut from. */
  function setup(lengthS = 700) {
    const shelf = new TitleSubtitleShelf(dir);
    const feeds = titleCueFeeds(shelf, () => undefined);
    const cuts: StretchRequest[] = [];
    const asked: WhisperRequest[] = [];
    const logs: string[] = [];
    const whisper = new CloudWhisper({
      stretchS: 300,
      shelf,
      feeds,
      cutter: async (request) => {
        cuts.push(request);
        return { ok: true, lengthS: Math.max(0, Math.min(request.lengthS, lengthS - request.startS)) };
      },
      transcriber: {
        transcribe: async (request: WhisperRequest) => (asked.push(request), [{ start_s: 1, end_s: 3, text: `heard ${path.basename(request.wav)}` }]),
        detect: async () => null,
        stop: async () => undefined,
      } as never,
      log: (line) => logs.push(line),
    });
    open.push(whisper);
    const session = (over: Partial<TranscriptSession> = {}): TranscriptSession & OutsideSession => {
      const stop = new AbortController();
      sessions.push(stop);
      return { ref: FILM, audioLang: 'zh', resumeS: null, outside: { subtitles: [], subtitleRev: 0, stop }, ...over } as TranscriptSession & OutsideSession;
    };
    const input = (): SyncInput => ({ url: HLS.manifest_url, inputArgs: ['-user_agent', 'UA'], hls: HLS });
    return { shelf, feeds, whisper, cuts, asked, logs, session, input };
  }
  const feedOf = async (t: ReturnType<typeof setup>) => (await t.feeds.get(KEY, 'whisper'))!.read(0);

  it('answers a growing English track at once and fills it from the stream, translated, to the end of the film', async () => {
    const t = setup();
    const s = t.session();
    const view = await t.whisper.track(s, t.input);
    expect(view).toEqual({ url: `/api/stream/subs/${KEY}/cues/whisper`, lang: 'en', label: 'English (Whisper)', growing: true });
    await expect.poll(async () => (await feedOf(t)).complete).toBe(true);
    // 700 s in stretches of 300 s: three cuts, each with the session's stream as the sync reads it (its headers, its HLS source).
    expect(t.cuts.map((c) => [c.startS, c.url, c.inputArgs, c.hls?.manifest_url])).toEqual([0, 300, 600].map((at) => [at, HLS.manifest_url, ['-user_agent', 'UA'], HLS.manifest_url]));
    expect(t.asked.every((a) => a.task === 'translate' && a.language === 'zh')).toBe(true);
    expect((await feedOf(t)).cues.map((c) => Math.floor(c.start_s))).toEqual([1, 301, 601]);
    // Kept beside the title's other subtitles, and never its chosen one: a later play asks the services first again.
    expect(JSON.parse(await readFile(path.join(dir, KEY, 'notesd-whisper', `${KEY}-0.json`), 'utf8'))).toMatchObject({ complete: true, done: [0, 300, 600] });
    expect(await t.shelf.kept(FILM)).toBeNull();
    // A replay reads the finished feed and cuts nothing.
    const before = t.cuts.length;
    expect((await t.whisper.track(t.session(), t.input))?.growing).toBe(true);
    expect(t.cuts).toHaveLength(before);
  });

  it('starts with the stretch the play starts in, and an English film is transcribed', async () => {
    const t = setup(1000);
    await t.whisper.track(t.session({ resumeS: 650, audioLang: 'en' }), t.input);
    await expect.poll(async () => (await feedOf(t)).complete).toBe(true);
    expect(t.cuts.map((c) => c.startS)).toEqual([600, 900, 300, 0]);
    expect(t.asked[0]).toMatchObject({ task: 'transcribe', language: 'en' });
  });

  it('stops when the session ends, and the next session carries on from what is done, reading its own stream', async () => {
    const t = setup(1400);
    const first = t.session();
    let stretches = 0;
    const stopAfterOne = (): SyncInput => {
      if ((stretches += 1) === 2) first.outside.stop.abort();
      return t.input();
    };
    await t.whisper.track(first, stopAfterOne);
    await expect.poll(() => t.logs.some((l) => /stopped/.test(l))).toBe(true);
    expect((await feedOf(t)).complete).toBe(false);
    const done = t.cuts.length;
    await t.whisper.track(t.session(), () => ({ url: 'http://127.0.0.1:7317/api/stream/cache/C1/f/index.m3u8' }));
    await expect.poll(async () => (await feedOf(t)).complete).toBe(true);
    const later = t.cuts.slice(done);
    expect(later.every((c) => c.url.includes('/api/stream/cache/C1/') && c.hls === undefined)).toBe(true);
    expect(later.map((c) => c.startS)).not.toContain(0);
  });

  it('the route answers the feed like a torrent\'s, and nothing outside a title folder', async () => {
    const t = setup();
    await t.whisper.track(t.session(), t.input);
    await expect.poll(async () => (await feedOf(t)).complete).toBe(true);
    const app = new Hono().route('/', directStreamRoutes({ directStream: {} as never, titleSubtitles: t.shelf, titleCues: t.feeds }));
    const got = await app.request(`/api/stream/subs/${KEY}/cues/whisper?after=1`);
    expect(got.status).toBe(200);
    expect(got.headers.get('cache-control')).toBe('no-store');
    expect(await got.json()).toMatchObject({ next: 3, complete: true, cues: [{ text: expect.stringContaining('heard') }, { text: expect.stringContaining('heard') }] });
    expect((await app.request(`/api/stream/subs/${KEY}/cues/whisper?after=x`)).status).toBe(400);
    expect((await app.request(`/api/stream/subs/${KEY}/cues/other`)).status).toBe(404);
    expect((await app.request('/api/stream/subs/movie-9/cues/whisper')).status).toBe(404);
    expect((await app.request('/api/stream/subs/..%2F..%2Fetc/cues/whisper')).status).toBe(404);
    expect((await new Hono().route('/', directStreamRoutes({ directStream: {} as never })).request(`/api/stream/subs/${KEY}/cues/whisper`)).status).toBe(404);
  });

  describe('as the last resort of the outside subtitles', () => {
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const SRT = '1\r\n00:00:01,000 --> 00:00:30,000\r\nFrom Wyzie.\r\n';
    function outsideWith(t: ReturnType<typeof setup>, o: { wyzie: () => Response | Promise<Response>; waitMs?: number; whisper?: boolean; sync?: SyncRequest[] }) {
      const calls: string[] = [];
      let clock = 1_000_000;
      const outside = new OutsideSubtitles({
        shelf: t.shelf,
        services: { baseUrl: 'https://os.fixture', wyzie: { baseUrl: 'https://w.fixture', key: 'k' }, fetch: async (url: string) => (calls.push(url), url.includes('/search') ? o.wyzie() : new Response(SRT)) },
        sync: o.sync === undefined ? null : { start: (request) => (o.sync?.push(request), null) },
        whisper: o.whisper === false ? null : t.whisper,
        imdbId: async () => null,
        ...(o.waitMs === undefined ? {} : { waitMs: o.waitMs }),
        now: () => clock,
        log: (line) => t.logs.push(line),
      });
      return { outside, calls, later: (ms: number) => void (clock += ms) };
    }
    const invalidId = (): Response => json({ code: 400, message: 'Invalid id' }, 400);

    it('a title Wyzie cannot map and the add-on cannot be asked about plays with the transcript, with the session', async () => {
      const t = setup();
      const sync: SyncRequest[] = [];
      const o = outsideWith(t, { wyzie: invalidId, sync });
      const s = t.session();
      await o.outside.attach(s, t.input);
      // Inside the inline wait: the page reads the track with the session, so nothing is bumped.
      expect(s.outside).toMatchObject({ subtitles: [{ label: 'English (Whisper)', growing: true }], subtitleRev: 0 });
      expect(o.calls).toHaveLength(1);
      expect(t.logs.join('\n')).toMatch(/no English subtitle anywhere; Whisper transcribes/);
      // Read again by the page: nothing is asked or started twice, and a transcript is never sent to be re-timed.
      await o.outside.attach(s, t.input);
      expect(o.calls).toHaveLength(1);
      expect(sync).toEqual([]);
      // Another play of the title within the quiet hours asks no service and gets the transcript too.
      const again = t.session();
      await o.outside.attach(again, t.input);
      expect(again.outside.subtitles[0]?.growing).toBe(true);
      expect(o.calls).toHaveLength(1);
      // Hours later the services are asked first again.
      o.later(OUTSIDE_EMPTY_MS + 1);
      await o.outside.attach(t.session(), t.input);
      expect(o.calls).toHaveLength(2);
    });

    it('a service that answers "none" after the play started brings the transcript behind it, and the page is told', async () => {
      const t = setup();
      let answer!: (res: Response) => void;
      const o = outsideWith(t, { wyzie: () => new Promise<Response>((resolve) => (answer = resolve)), waitMs: 20 });
      const s = t.session();
      await o.outside.attach(s, t.input);
      expect(s.outside).toMatchObject({ subtitles: [], subtitleRev: 0 });
      answer(invalidId());
      await expect.poll(() => s.outside.subtitleRev).toBe(1);
      expect(s.outside.subtitles[0]).toMatchObject({ label: 'English (Whisper)', growing: true });
    });

    it('a subtitle the services do have is shown, and Whisper is not started', async () => {
      const t = setup();
      const o = outsideWith(t, { wyzie: () => json([{ id: '1', url: 'https://w.fixture/c/1?tok=t', format: 'srt', language: 'en', isHearingImpaired: false, release: 'r', fileName: 'a.srt', downloadCount: 1, ai: false }]) });
      const s = t.session();
      await o.outside.attach(s, t.input);
      expect(s.outside.subtitles).toEqual([{ url: `/api/stream/subs/${KEY}/outside.vtt`, lang: 'en', label: 'English (Wyzie)' }]);
      expect(t.cuts).toEqual([]);
    });

    it('without Whisper, and for a session that already ended, nothing is added', async () => {
      const t = setup();
      const off = outsideWith(t, { wyzie: invalidId, whisper: false });
      const s = t.session();
      await off.outside.attach(s, t.input);
      expect(s.outside.subtitles).toEqual([]);
      const on = outsideWith(t, { wyzie: invalidId });
      const ended = t.session();
      ended.outside.stop.abort();
      await on.outside.attach(ended, t.input);
      expect(ended.outside.subtitles).toEqual([]);
      expect(t.cuts).toEqual([]);
    });
  });
});
