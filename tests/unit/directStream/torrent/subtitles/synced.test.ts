import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CacheSubtitleView } from '../../../../../src/directStream/cachePlay.js';
import { SubtitleShelf, subtitleUrl } from '../../../../../src/directStream/torrent/subtitles/disk.js';
import {
  addSpeech,
  buildSubtitleSync,
  horizonsFor,
  parseSpeech,
  readSyncOutcome,
  torrentSyncPlace,
  parseSyncAnswer,
  SubtitleSync,
  SyncError,
  SYNCED_LABEL,
  syncRequestBody,
  wantsSync,
  wyzieSynced,
  type SpeechSpan,
  type SyncRequest,
  type SyncTarget,
} from '../../../../../src/directStream/torrent/subtitles/synced.js';
import type { AudioCutter } from '../../../../../src/directStream/torrent/subtitles/whisper.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/torrent-subtitles/wyzie-synced-speech.json');
const HASH = 'a'.repeat(40);
const KEY = 'wyzie-test-key';
const BASE = 'https://w.fixture';
const TOK_URL = 'https://w.fixture/c/77?tok=secret.token';
const FILM = { kind: 'movie', tmdbId: 2252 } as const;
const SRT = (line: string): string => `1\r\n00:00:01,000 --> 00:00:30,000\r\n${line}\r\n`;
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const OK = { url: TOK_URL, offset: -0.89, fps: '23.976:24', confidence: 1, inSync: false, subtitle: { release: 'Eastern.Promises.2007.BluRay', fileName: 'ep.srt', source: 'opensubtitles', isHearingImpaired: false, format: 'srt' }, tried: 2 };
const never = new AbortController().signal;

interface Call {
  url: string;
  body: Record<string, unknown> | null;
}

/** Wyzie as a list of answers to `POST /sync`, in order; the download address answers SubRip. */
function wyzie(answers: Array<() => Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null });
    if (url === `${BASE}/sync`) return (answers.shift() ?? (() => json({ error: 'unexpected' }, 500)))();
    if (url === TOK_URL) return new Response(SRT('In step now.'), { status: 200 });
    return new Response('', { status: 404 });
  };
  const posts = (): Call[] => calls.filter((c) => c.url === `${BASE}/sync`);
  return { fetchImpl, calls, posts };
}

describe('the Wyzie Synced client', () => {
  it('posts the speech of the sample by IMDb id and answers the fixed file as WebVTT', async () => {
    const sample = JSON.parse(await readFile(FIXTURE, 'utf8')) as { speech: SpeechSpan[]; covered: SpeechSpan[] };
    const w = wyzie([() => json(OK)]);
    const got = await wyzieSynced({ baseUrl: BASE, key: KEY, fetch: w.fetchImpl }, { ref: FILM, imdbId: 'tt0765443', speech: sample.speech, covered: sample.covered }, never);
    expect(w.posts()[0]!.body).toEqual({ key: KEY, id: 'tt0765443', language: 'en', speech: sample.speech, covered: [[0, 1800]] });
    expect(sample.speech.length).toBe(377);
    expect(got.vtt).toMatch(/^WEBVTT/);
    expect(got.vtt).toContain('In step now.');
    expect(got.info).toEqual({ offsetS: -0.89, fps: '23.976:24', confidence: 1, inSync: false, release: 'Eastern.Promises.2007.BluRay' });
  });

  it('asks an episode with its season and episode, by the TMDB id when no IMDb id is known', () => {
    expect(syncRequestBody(KEY, { ref: { kind: 'tv', tmdbId: 1396, season: 2, episode: 3 }, imdbId: null, speech: [[1, 2]], covered: [[0, 10]] })).toEqual({
      key: KEY, id: '1396', language: 'en', season: 2, episode: 3, speech: [[1, 2]], covered: [[0, 10]],
    });
  });

  it.each([
    [422, { error: "Couldn't sync" }, 'no_fit'],
    [404, { error: 'No subtitles found' }, 'none'],
    [403, { error: 'Paid feature' }, 'failed'],
    [429, { message: 'Too many requests' }, 'failed'],
    [503, 'gateway', 'failed'],
  ])('a %i is a SyncError that says the status and what Wyzie said', async (status, body, kind) => {
    const w = wyzie([() => (typeof body === 'string' ? new Response(body, { status }) : json(body, status))]);
    const err = await wyzieSynced({ baseUrl: BASE, key: KEY, fetch: w.fetchImpl }, { ref: FILM, imdbId: 'tt1', speech: [], covered: [] }, never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).kind).toBe(kind);
    expect((err as SyncError).message).toContain(`HTTP ${status}`);
    // A refused sync is free, and no file is asked for.
    expect(w.calls).toHaveLength(1);
  });

  it('never puts the key or a token into an error', async () => {
    const boom = async (): Promise<Response> => {
      throw new Error(`connect failed: ${BASE}/sync?key=${KEY} then ${TOK_URL}`);
    };
    const err = (await wyzieSynced({ baseUrl: BASE, key: KEY, fetch: boom }, { ref: FILM, imdbId: 'tt1', speech: [], covered: [] }, never).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain('secret.token');
    const echo = wyzie([() => json({ error: `bad request for ${BASE}/x?key=${KEY}` }, 400)]);
    const said = (await wyzieSynced({ baseUrl: BASE, key: KEY, fetch: echo.fetchImpl }, { ref: FILM, imdbId: 'tt1', speech: [], covered: [] }, never).catch((e: unknown) => e)) as Error;
    expect(said.message).not.toContain(KEY);
    const dead = async (url: string): Promise<Response> => (url === `${BASE}/sync` ? json(OK) : new Response('', { status: 410 }));
    const gone = (await wyzieSynced({ baseUrl: BASE, key: KEY, fetch: dead }, { ref: FILM, imdbId: 'tt1', speech: [], covered: [] }, never).catch((e: unknown) => e)) as Error;
    expect(gone.message).toBe('the synced file answered HTTP 410');
  });

  it('reads the answer once where it enters', () => {
    expect(parseSyncAnswer({ url: TOK_URL, offset: 'x', fps: null, inSync: true }).info).toEqual({ offsetS: null, fps: null, confidence: null, inSync: true, release: null });
    expect(() => parseSyncAnswer({ url: 'ftp://w.fixture/x' })).toThrow(/names no file/);
    expect(() => parseSyncAnswer([])).toThrow(SyncError);
  });
});

describe('speech and horizons', () => {
  it('keeps only well-formed stretches of the detector, and refuses anything that is not a list', () => {
    expect(parseSpeech([[1, 2.5], [3, 3], ['a', 4], [5], [-1, 2], [6, 7.25]])).toEqual([[1, 2.5], [6, 7.25]]);
    expect(() => parseSpeech({ error: 'x' })).toThrow(/did not print a list/);
  });

  it('moves a stretch to film time and joins speech across a seam', () => {
    const all: SpeechSpan[] = [];
    addSpeech(all, [[10, 12], [12, 14], [298.4, 300]], 0);
    addSpeech(all, [[0, 1.5], [20, 21]], 300);
    // The detector's own split at 12 s stays; only the seam at 300 s is joined.
    expect(all).toEqual([[10, 12], [12, 14], [298.4, 301.5], [320, 321]]);
    addSpeech(all, [[0.5, 2]], 600);
    expect(all.at(-1)).toEqual([600.5, 602]);
  });

  it('tries 30 minutes, 60 minutes, then the whole file, each only when the film is longer', () => {
    expect(horizonsFor(6028)).toEqual([1800, 3600, 6028]);
    expect(horizonsFor(2700)).toEqual([1800, 2700]);
    expect(horizonsFor(1500)).toEqual([1500]);
    expect(horizonsFor(null)).toEqual([1800, 3600, Number.POSITIVE_INFINITY]);
  });

  it('syncs only a subtitle that came from outside the torrent', () => {
    const view = (name: string, over: Partial<CacheSubtitleView> = {}): CacheSubtitleView => ({ url: subtitleUrl(HASH, name), lang: 'en', label: 'English', ...over });
    expect(wantsSync([view('service-wyzie-123.vtt')])).toBe(true);
    expect(wantsSync([view('service-55.vtt')])).toBe(true);
    expect(wantsSync([view('borrow.vtt')])).toBe(true);
    expect(wantsSync([view('file-3.vtt')])).toBe(false);
    expect(wantsSync([view('synced-0.vtt')])).toBe(false);
    // A cloud session's outside file is; its synced one is not.
    expect(wantsSync([{ url: '/api/stream/subs/movie-550/outside.vtt', lang: 'en', label: 'English (Wyzie)' }])).toBe(true);
    expect(wantsSync([{ url: '/api/stream/subs/tv-1396-s1e2/synced.vtt', lang: 'en', label: SYNCED_LABEL }])).toBe(false);
    expect(wantsSync([{ url: `/api/stream/torrent/${HASH}/cues/whisper-0`, lang: 'en', label: 'English (Whisper)', growing: true }])).toBe(false);
    expect(wantsSync([])).toBe(false);
  });
});

describe('SubtitleSync', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'notesd-synced-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A film of `filmS` seconds with 40 s of speech in every 100 s; the cutter writes nothing and says what it cut. */
  function setup(o: { filmS?: number; answers: Array<() => Response>; detect?: (wav: string) => Promise<SpeechSpan[]>; ready?: boolean; cut?: AudioCutter } = { answers: [] }) {
    const filmS = o.filmS ?? 6028;
    const shelf = new SubtitleShelf(dir);
    const w = wyzie(o.answers);
    const cuts: Array<[number, number]> = [];
    const inputs: string[] = [];
    const lengths = new Map<string, number>();
    const logs: string[] = [];
    const cutter: AudioCutter =
      o.cut ??
      (async (request) => {
        cuts.push([request.startS, request.lengthS]);
        inputs.push(request.url);
        const lengthS = Math.max(0, Math.min(request.lengthS, filmS - request.startS));
        lengths.set(request.out, lengthS);
        return { ok: true, lengthS };
      });
    const place = torrentSyncPlace({ torrentDir: dir, shelf, input: (infoHash, fileIndex) => `http://127.0.0.1:1/api/stream/torrent/${infoHash}/f/${fileIndex}` }, HASH, 0);
    const sync = new SubtitleSync({
      wyzie: { baseUrl: BASE, key: KEY },
      fetch: w.fetchImpl,
      cutter,
      detect: o.detect ?? (async (wav) => Array.from({ length: Math.floor((lengths.get(wav) ?? 0) / 100) }, (_, i): SpeechSpan => [i * 100 + 10, i * 100 + 50])),
      ...(o.ready === undefined ? {} : { ready: () => o.ready === true }),
      now: () => new Date('2026-11-17T10:00:00Z'),
      log: (line) => logs.push(line),
    });
    const session = async (name = 'service-wyzie-9.vtt'): Promise<{ target: SyncTarget; stop: AbortController; request: SyncRequest }> => {
      const view = await shelf.save(HASH, name, 'WEBVTT\n\n00:00:02.000 --> 00:00:31.000\nOut of step.\n', { lang: 'en', label: 'English (Wyzie)' });
      const target: SyncTarget = { subtitles: [view], subtitleRev: 0 };
      const stop = new AbortController();
      return { target, stop, request: { ref: FILM, imdbId: 'tt0765443', key: `${HASH}-0`, durationS: filmS, signal: stop.signal, target, place } };
    };
    return { sync: Object.assign(sync, { outcome: () => readSyncOutcome(place.outcomeFile) }), shelf, w, cuts, logs, session, inputs };
  }

  it('listens to the first 30 minutes in stretches, and the synced file replaces the session subtitle and the kept one', async () => {
    const t = setup({ answers: [() => json(OK)] });
    const s = await t.session();
    await t.sync.start(s.request);
    expect(t.cuts).toEqual([[0, 300], [300, 300], [600, 300], [900, 300], [1200, 300], [1500, 300]]);
    expect(new Set(t.inputs)).toEqual(new Set([`http://127.0.0.1:1/api/stream/torrent/${HASH}/f/0`]));
    const body = t.w.posts()[0]!.body!;
    expect(body).toMatchObject({ key: KEY, id: 'tt0765443', language: 'en', covered: [[0, 1800]] });
    expect((body.speech as SpeechSpan[]).length).toBe(18);
    expect((body.speech as SpeechSpan[])[3]).toEqual([310, 350]);
    const synced = { url: subtitleUrl(HASH, 'synced-0.vtt'), lang: 'en', label: SYNCED_LABEL };
    expect(s.target).toEqual({ subtitles: [synced], subtitleRev: 1 });
    // A replay from disk finds the synced file through the kept tier, and it is never synced again.
    expect(await t.shelf.kept(HASH)).toEqual([synced]);
    expect(await readFile(t.shelf.file(HASH, 'synced-0.vtt')!, 'utf8')).toContain('In step now.');
    expect(await t.sync.outcome()).toEqual({ state: 'done', retry: false, reason: null, at: '2026-11-17T10:00:00.000Z', covered_s: 1800, offset_s: -0.89, fps: '23.976:24', confidence: 1, in_sync: false, release: 'Eastern.Promises.2007.BluRay' });
    expect(wantsSync(s.target.subtitles)).toBe(false);
    expect(t.logs.join('\n')).toContain('offset -0.89 s, fps 23.976:24, confidence 1');
    // The WAVs are gone, and nothing on disk or in the log holds the key or the token.
    const files = await readdir(dir, { recursive: true });
    expect(files.filter((f) => f.endsWith('.wav'))).toEqual([]);
    const kept = (await Promise.all(files.filter((f) => /\.(json|vtt)$/.test(f)).map((f) => readFile(path.join(dir, f), 'utf8')))).join('\n') + t.logs.join('\n');
    expect(kept).not.toContain(KEY);
    expect(kept).not.toContain('tok=');
  });

  it('goes on to 60 minutes and then the whole film after a 422, hearing only what is new', async () => {
    const t = setup({ answers: [() => json({ error: "Couldn't sync" }, 422), () => json({ error: 'No speech found' }, 422), () => json({ ...OK, inSync: true, offset: 0 })] });
    const s = await t.session('borrow.vtt');
    await t.sync.start(s.request);
    expect(t.w.posts().map((c) => c.body!.covered)).toEqual([[[0, 1800]], [[0, 3600]], [[0, 6028]]]);
    expect(t.cuts).toHaveLength(21);
    expect(t.cuts.at(-1)).toEqual([6000, 28]);
    // In step already, and still Wyzie's best fit of five: it replaces the borrowed file.
    expect(s.target.subtitles[0]!.label).toBe(SYNCED_LABEL);
    expect(s.target.subtitleRev).toBe(1);
    expect((await t.sync.outcome())?.in_sync).toBe(true);
  });

  it('a film under 30 minutes goes straight to the whole file', async () => {
    const t = setup({ filmS: 1320, answers: [() => json(OK)] });
    const s = await t.session();
    await t.sync.start(s.request);
    expect(t.w.posts().map((c) => c.body!.covered)).toEqual([[[0, 1320]]]);
  });

  it('remembers that no subtitle lines up, keeps the old subtitle, and a replay asks nothing', async () => {
    const t = setup({ filmS: 2400, answers: [() => json({ error: "Couldn't sync" }, 422), () => json({ error: "Couldn't sync" }, 422)] });
    const s = await t.session();
    await t.sync.start(s.request);
    expect(s.target.subtitleRev).toBe(0);
    expect(s.target.subtitles[0]!.url).toBe(subtitleUrl(HASH, 'service-wyzie-9.vtt'));
    expect(await t.sync.outcome()).toMatchObject({ state: 'failed', retry: false, reason: "the sync answered HTTP 422 (Couldn't sync)", covered_s: 2400 });
    const again = await t.session();
    await t.sync.start(again.request);
    expect(t.w.posts()).toHaveLength(2);
    expect(t.cuts).toHaveLength(8);
    expect(t.logs.at(-1)).toContain('is not synced again');
  });

  it('ends on any other failure, and the next play tries again', async () => {
    const t = setup({ answers: [() => json({ error: 'Too many requests' }, 429), () => json(OK)] });
    const s = await t.session();
    await t.sync.start(s.request);
    expect(t.w.posts()).toHaveLength(1);
    expect(await t.sync.outcome()).toMatchObject({ state: 'failed', retry: true });
    expect(s.target.subtitleRev).toBe(0);
    const again = await t.session();
    await t.sync.start(again.request);
    expect(again.target.subtitleRev).toBe(1);
    expect((await t.sync.outcome())?.state).toBe('done');
  });

  it('a film with almost no speech is not sent at all', async () => {
    const t = setup({ filmS: 2000, answers: [], detect: async () => [[1, 3]] });
    const s = await t.session();
    await t.sync.start(s.request);
    expect(t.w.calls).toEqual([]);
    expect(await t.sync.outcome()).toMatchObject({ state: 'failed', retry: false });
  });

  it('stops when the session lets go of the torrent, pays nothing and leaves no outcome', async () => {
    let s!: Awaited<ReturnType<ReturnType<typeof setup>['session']>>;
    let cutCount = 0;
    const t = setup({
      answers: [() => json(OK)],
      cut: async (_request, signal) => {
        cutCount += 1;
        if (cutCount === 2) s.stop.abort();
        signal.throwIfAborted();
        return { ok: true, lengthS: 300 };
      },
    });
    s = await t.session();
    await t.sync.start(s.request);
    expect(t.w.calls).toEqual([]);
    expect(await t.sync.outcome()).toBeNull();
    expect(s.target.subtitleRev).toBe(0);
    expect(t.logs.at(-1)).toContain('the torrent was released');
  });

  it('two sessions on one file share one job, and both get the synced subtitle', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const t = setup({ answers: [() => json(OK)], detect: async () => (await gate, [[10, 200]]) });
    const a = await t.session();
    const b = await t.session();
    const job = t.sync.start(a.request);
    expect(t.sync.start(b.request)).toBeNull();
    release();
    await job;
    expect(t.w.posts()).toHaveLength(1);
    expect([a.target.subtitleRev, b.target.subtitleRev]).toEqual([1, 1]);
  });

  it('starts nothing for a subtitle of the torrent itself, an aborted session, or without the Python', async () => {
    const t = setup({ answers: [], ready: false });
    const own = await t.session('file-2.vtt');
    expect(t.sync.start(own.request)).toBeNull();
    const gone = await t.session();
    gone.stop.abort();
    expect(t.sync.start(gone.request)).toBeNull();
    const s = await t.session();
    await t.sync.start(s.request);
    expect(t.cuts).toEqual([]);
    expect(t.w.calls).toEqual([]);
    expect(t.logs.at(-1)).toContain("Whisper's Python is not installed");
    expect(await t.sync.outcome()).toBeNull();
  });

  it('a cut that fails ends the job for this play only', async () => {
    const t = setup({ answers: [], cut: async () => ({ ok: false, reason: 'ffmpeg exited 1' }) });
    const s = await t.session();
    await t.sync.start(s.request);
    expect(await t.sync.outcome()).toMatchObject({ state: 'failed', retry: true, reason: 'the audio at 0 s could not be cut: ffmpeg exited 1' });
  });

  it('is built only with the setting on and a Wyzie key', async () => {
    const common = { ffmpegBin: 'ffmpeg', fetch: async () => new Response('') };
    expect(buildSubtitleSync({ ...common, sync: null, wyzie: { baseUrl: BASE, key: KEY } })).toBeNull();
    expect(buildSubtitleSync({ ...common, sync: { python: '/nope/python' }, wyzie: null })).toBeNull();
    const built = buildSubtitleSync({ ...common, sync: { python: path.join(dir, 'no-python') }, wyzie: { baseUrl: BASE, key: KEY }, log: () => undefined });
    expect(built).toBeInstanceOf(SubtitleSync);
    // No Python there: the job is skipped, nothing is cut or asked.
    const shelf = new SubtitleShelf(dir);
    const view = await shelf.save(HASH, 'borrow.vtt', 'WEBVTT\n\n00:00:02.000 --> 00:00:31.000\nx\n', { lang: 'en', label: 'English (VidFast)' });
    const target: SyncTarget = { subtitles: [view], subtitleRev: 0 };
    await built!.start({ ref: FILM, imdbId: null, key: `${HASH}-0`, durationS: 100, signal: never, target, place: torrentSyncPlace({ torrentDir: dir, shelf, input: () => 'x' }, HASH, 0) });
    expect(target.subtitleRev).toBe(0);
  });
});
