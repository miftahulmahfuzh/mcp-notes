import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import type { EvidenceInput, EvidenceRecord, EvidenceSink } from '../../src/directStream/evidence.js';
import { DirectStreamRepo } from '../../src/directStream/repo.js';
import { directStreamScriptRunner } from '../../src/directStream/runner.js';
import { DirectStreamService, type DirectStreamHooks, type SessionInfo } from '../../src/directStream/service.js';
import { SESSION_IDLE_MS, SessionStore } from '../../src/directStream/sessions.js';
import type { ResolveAttempt, ResolveOutput, StreamRef } from '../../src/directStream/types.js';
import { directStreamRoutes } from '../../src/http/directStreamApi.js';
// @ts-expect-error -- plain .mjs fixture without type declarations
import { startUpstream } from '../fixtures/direct-stream/upstream.mjs';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/direct-stream');
const FAKE_CLI = path.join(FIXTURES, 'fake-cli.mjs');
const SAME_ORIGIN = { origin: 'http://localhost' };
const PAGE_BASE = 'http://localhost:4321';
const SEED = [
  { name: 'Alpha', movie: 'https://alpha.example/movie/{id}', en_subtitle: true },
  { name: 'Bravo', movie: 'https://bravo.example/movie/{id}', tv: 'https://bravo.example/tv/{id}/{season}/{episode}' },
  { name: 'Charlie', movie: 'https://charlie.example/e/{id}', browser_only: true },
];

interface UpstreamRequest {
  path: string;
  host: string;
  referer: string | null;
  origin: string | null;
  user_agent: string | null;
  range: string | null;
  cookie: string | null;
}
interface Upstream {
  origin: string;
  altOrigin: string;
  requests: UpstreamRequest[];
  close(): Promise<void>;
}
interface PlayJson {
  ok: true;
  page_url: string;
  session: SessionInfo;
  attempts: ResolveAttempt[];
}

let db: Db;
let up: Upstream;
let fakeDir: string;
let clock: Date;
let records: { ref: StreamRef; result: ResolveOutput }[];

const through = (sid: string, u: string): string => `/api/stream/sessions/${sid}/p?u=${encodeURIComponent(u)}`;

async function mode(m: 'hls' | 'dash' | 'no_source' | 'no_chrome'): Promise<void> {
  await writeFile(path.join(fakeDir, 'mode'), `${m}\n`);
}

async function calls(): Promise<string[][]> {
  try {
    const text = await readFile(path.join(fakeDir, 'calls.jsonl'), 'utf8');
    return text.trim() === '' ? [] : text.trim().split('\n').map((l) => (JSON.parse(l) as { args: string[] }).args);
  } catch {
    return [];
  }
}

function service(host = 'host-a', hooks: DirectStreamHooks = {}, evidence: EvidenceSink | null = null): DirectStreamService {
  return new DirectStreamService({
    repo: new DirectStreamRepo(db),
    runner: directStreamScriptRunner({ cliPath: FAKE_CLI }),
    host,
    seedFile: path.join(fakeDir, 'seed.json'),
    pageBase: () => PAGE_BASE,
    hooks: {
      recordResolve: async (ref, result) => {
        records.push({ ref, result });
      },
      ...hooks,
    },
    sessions: new SessionStore(() => clock),
    now: () => clock,
    log: () => undefined,
    evidence,
  });
}

function appFor(svc: DirectStreamService | null): Hono {
  const app = new Hono();
  app.route('/', directStreamRoutes({ directStream: svc }));
  return app;
}

async function ready(host = 'host-a', hooks: DirectStreamHooks = {}): Promise<{ svc: DirectStreamService; app: Hono }> {
  const svc = service(host, hooks);
  await svc.syncSeed();
  return { svc, app: appFor(svc) };
}

async function play(app: Hono, body: unknown = { kind: 'movie', tmdb_id: 550 }, headers: Record<string, string> = SAME_ORIGIN): Promise<Response> {
  return app.request('/api/stream/play', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

async function played(app: Hono, body?: unknown): Promise<PlayJson> {
  const res = await play(app, body);
  expect(res.status).toBe(200);
  return (await res.json()) as PlayJson;
}

beforeAll(async () => {
  db = openTestDb();
  up = (await startUpstream()) as Upstream;
  fakeDir = await mkdtemp(path.join(os.tmpdir(), 'direct-stream-api-'));
  await writeFile(path.join(fakeDir, 'upstream.json'), JSON.stringify({ origin: up.origin, alt_origin: up.altOrigin }));
  await writeFile(path.join(fakeDir, 'seed.json'), JSON.stringify(SEED));
  process.env.DIRECT_STREAM_FAKE_DIR = fakeDir;
});

afterAll(async () => {
  delete process.env.DIRECT_STREAM_FAKE_DIR;
  await up.close();
  await rm(fakeDir, { recursive: true, force: true });
  await closeTestDb(db);
});

beforeEach(async () => {
  await truncateAll(db);
  await rm(path.join(fakeDir, 'calls.jsonl'), { force: true });
  await mode('hls');
  up.requests.length = 0;
  clock = new Date('2026-11-15T12:00:00Z');
  records = [];
});

describe('POST /api/stream/play', () => {
  it('resolves through the registry, opens the player page full screen and answers the session', async () => {
    const { app } = await ready();
    const json = await played(app);
    const sid = json.session.session_id;
    expect(sid).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(json.page_url).toBe(`${PAGE_BASE}/stream/${sid}`);
    expect(json.session).toMatchObject({
      kind: 'movie', tmdb_id: 550, season: null, episode: null, title: 'TMDB movie 550', provider: 'Bravo',
      manifest_kind: 'hls', manifest_url: through(sid, `${up.origin}/hls/master.m3u8`), best_height: 1080, resume_s: null,
    });
    expect(json.session.subtitles).toEqual([
      { url: `${through(sid, `${up.origin}/subs/en.srt`)}&vtt=1`, lang: 'en', label: 'English', format: 'vtt', source: 'request', english: true },
    ]);
    expect(json.attempts).toEqual([
      { provider: 'Alpha', outcome: 'bot_check', took_s: 1.2, detail: 'fake: Just a moment...' },
      { provider: 'Bravo', outcome: 'resolved', took_s: 2.5, detail: '' },
    ]);
    const c = await calls();
    expect(c.map((a) => a[0])).toEqual(['resolve', 'open']);
    expect(c[0]?.slice(0, 3)).toEqual(['resolve', 'movie', '550']);
    expect(c[1]).toEqual(['open', `${PAGE_BASE}/stream/${sid}`, '--fullscreen']);
    expect(records).toHaveLength(1);
    expect(records[0]?.result).toMatchObject({ ok: true, source: { provider: 'Bravo' } });
  });

  it('passes an episode to the resolver', async () => {
    const { app } = await ready();
    const json = await played(app, { kind: 'tv', tmdb_id: 1399, season: 1, episode: 2 });
    expect(json.session).toMatchObject({ kind: 'tv', tmdb_id: 1399, season: 1, episode: 2, title: 'TMDB tv 1399 S01E02' });
    expect((await calls())[0]?.slice(0, 5)).toEqual(['resolve', 'tv', '1399', '1', '2']);
  });

  it('records health for this host after every resolve, leaving skipped providers alone', async () => {
    const { svc, app } = await ready('host-a');
    await played(app);
    const view = await svc.providers();
    expect(view.map((p) => [p.name, p.health?.last_outcome ?? null, p.health?.successes ?? null, p.health?.failures ?? null])).toEqual([
      ['Alpha', 'bot_check', 0, 1],
      ['Bravo', 'resolved', 1, 0],
      ['Charlie', null, null, null],
    ]);
    expect(view[1]?.health).toMatchObject({ en_subtitle: true, best_height: 1080, manifest_kind: 'hls', median_s: 2.5 });
    expect((await service('host-b').providers()).every((p) => p.health === null)).toBe(true);
  });

  it('answers no_source with every attempt, opens nothing, and records the failures', async () => {
    const { svc, app } = await ready();
    await mode('no_source');
    const res = await play(app);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: 'no_source',
      attempts: [
        { provider: 'Alpha', outcome: 'no_stream' },
        { provider: 'Bravo', outcome: 'no_stream' },
      ],
    });
    expect((await calls()).map((a) => a[0])).toEqual(['resolve']);
    expect(records[0]?.result).toMatchObject({ ok: false, error: 'no_source' });
    expect((await svc.providers()).filter((p) => p.health?.failures === 1).map((p) => p.name)).toEqual(['Alpha', 'Bravo']);
  });

  it('answers resolve_failed with the reason when the streaming Chrome cannot be reached', async () => {
    const { svc, app } = await ready();
    await mode('no_chrome');
    const res = await play(app);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'resolve_failed', reason: 'no_chrome' });
    expect((await svc.providers()).every((p) => p.health === null)).toBe(true);
    expect(records[0]?.result).toMatchObject({ ok: false, error: 'no_chrome' });
  });

  it('validates the body and the Origin', async () => {
    const { app } = await ready();
    expect((await play(app, { kind: 'movie', tmdb_id: 550, season: 1 })).status).toBe(400);
    expect((await play(app, { kind: 'tv', tmdb_id: 1399, season: 1 })).status).toBe(400);
    expect((await play(app, { kind: 'movie', tmdb_id: 0 })).status).toBe(400);
    const notJson = await app.request('/api/stream/play', { method: 'POST', headers: SAME_ORIGIN, body: 'nope' });
    expect(((await notJson.json()) as { error: string }).error).toBe('invalid_json');
    const foreign = await play(app, { kind: 'movie', tmdb_id: 550 }, {});
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as { error: string }).error).toBe('forbidden_origin');
    expect(await calls()).toEqual([]);
  });

  it('takes resume_s from the body, else from the resume hook, and the title from its hook', async () => {
    const { app } = await ready('host-a', { resumeS: async () => 1234.5, titleLabel: async () => 'Fight Club (1999)' });
    expect((await played(app)).session).toMatchObject({ resume_s: 1234.5, title: 'Fight Club (1999)' });
    expect((await played(app, { kind: 'movie', tmdb_id: 550, resume_s: 60 })).session.resume_s).toBe(60);
  });
});

describe('the dialogue', () => {
  it("reads the resolved stream's English subtitle as WebVTT through the pass-through, and opens no player", async () => {
    const { svc } = await ready();
    const read = await svc.subtitleText({ kind: 'movie', tmdbId: 550 });
    expect(read.provider).not.toBe('');
    // The fixture's .srt, converted: one cue.
    expect(read.vtt.startsWith('WEBVTT')).toBe(true);
    expect(read.vtt).toContain('00:00:01.000 --> 00:00:03.000');
    expect(read.vtt).toContain('Hello.');
    expect((await calls()).filter((c) => c[0] === 'open')).toEqual([]);
    // The file was asked for with the headers the resolve captured.
    expect(up.requests.find((r) => r.path === '/subs/en.srt')).toMatchObject({ status: 200, referer: 'https://embed.fixture/' });
  });

  it('joins the segments of a subtitle playlist inside the manifest', async () => {
    const { svc } = await ready();
    const session = await svc.resolve({ kind: 'movie', tmdbId: 550 });
    const read = (svc as unknown as { readSubtitle(s: unknown, url: string, format: string): Promise<string | null> }).readSubtitle.bind(svc);
    const vtt = await read(session, `${up.origin}/hls/subs/en.m3u8`, 'hls');
    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('Hello.');
    // An address outside the session's hosts is refused, as the player's would be.
    expect(await read(session, 'https://elsewhere.example/en.vtt', 'vtt')).toBeNull();
  });

  it('answers no_source when nothing resolves', async () => {
    const { svc } = await ready();
    await mode('no_source');
    await expect(svc.subtitleText({ kind: 'movie', tmdbId: 550 })).rejects.toMatchObject({ code: 'no_source' });
  });
});

describe('the previous and next episode', () => {
  const EPISODE = { kind: 'tv', tmdb_id: 1396, season: 2, episode: 3 };
  const neighbors = async () => ({ prev: { season: 2, episode: 2 }, next: { season: 2, episode: 4 } });
  const go = (app: Awaited<ReturnType<typeof ready>>['app'], id: string, body: unknown, headers: Record<string, string> = SAME_ORIGIN) =>
    app.request(`/api/stream/sessions/${id}/episode`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('a session names its neighbours, and the episode route resolves the one asked for into a new session', async () => {
    const { app } = await ready('host-a', { neighbors });
    const first = (await played(app, EPISODE)).session as { session_id: string; prev_episode: unknown; next_episode: unknown };
    expect(first).toMatchObject({ prev_episode: { season: 2, episode: 2 }, next_episode: { season: 2, episode: 4 } });
    const res = await go(app, first.session_id, { to: 'next' });
    expect(res.status).toBe(200);
    const next = (await res.json()) as { session_id: string; season: number; episode: number };
    expect(next).toMatchObject({ kind: 'tv', tmdb_id: 1396, season: 2, episode: 4 });
    expect(next.session_id).not.toBe(first.session_id);
    // The resolver was asked for S02E04, and the player page was not opened again.
    const all = await calls();
    expect(all.filter((c) => c[0] === 'resolve').map((c) => c.slice(1, 5))).toEqual([['tv', '1396', '2', '3'], ['tv', '1396', '2', '4']]);
    expect(all.filter((c) => c[0] === 'open')).toHaveLength(1);
    // Both sessions answer: the old one is left to expire.
    expect((await app.request(`/api/stream/sessions/${first.session_id}`)).status).toBe(200);
    expect((await app.request(`/api/stream/sessions/${next.session_id}`)).status).toBe(200);
  });

  it('answers no_episode for a film or a side without an episode, and refuses a bad body, another origin and an unknown session', async () => {
    const { app } = await ready('host-a', { neighbors: async () => ({ prev: null, next: { season: 2, episode: 4 } }) });
    const film = (await played(app)).session as { session_id: string; prev_episode: unknown; next_episode: unknown };
    expect(film).toMatchObject({ prev_episode: null, next_episode: null });
    expect((await go(app, film.session_id, { to: 'next' })).status).toBe(404);
    const episode = (await played(app, EPISODE)).session as { session_id: string };
    const none = await go(app, episode.session_id, { to: 'prev' });
    expect([none.status, ((await none.json()) as { error: string }).error]).toEqual([404, 'no_episode']);
    expect((await go(app, episode.session_id, { to: 'sideways' })).status).toBe(400);
    expect((await go(app, episode.session_id, { to: 'next' }, {})).status).toBe(403);
    expect((await go(app, 'nope', { to: 'next' })).status).toBe(403);
  });
});

describe('the original language', () => {
  it("passes the title's original language to the resolver and to the player's session", async () => {
    const { app } = await ready('host-a', { originalLanguage: async () => 'KO' });
    const json = await played(app);
    expect(json.session).toMatchObject({ audio_lang: 'ko', audio: null });
    const [resolve] = await calls();
    expect(resolve?.slice(resolve.indexOf('--audio-lang'), resolve.indexOf('--audio-lang') + 2)).toEqual(['--audio-lang', 'ko']);
  });

  it("passes an anime's AniList id and episode to the resolver, and nothing for a title that has none or when the hook fails", async () => {
    const { app } = await ready('host-a', { anime: async () => ({ id: 21, episode: 730 }) });
    await played(app);
    const [resolve] = await calls();
    expect(resolve?.slice(resolve.indexOf('--anime'), resolve.indexOf('--anime') + 2)).toEqual(['--anime', '21:730']);
    for (const anime of [async () => null, async () => ({ id: 0, episode: 1 }), async () => Promise.reject(new Error('index down'))]) {
      const again = await ready('host-a', { anime });
      await played(again.app);
    }
    expect((await calls()).filter((c) => c.includes('--anime'))).toHaveLength(1);
  });

  it('asks for no audio check when the language is unknown, is not a code, or its hook fails', async () => {
    for (const originalLanguage of [async () => null, async () => 'korean (south)', async () => Promise.reject(new Error('tmdb down'))]) {
      const { app } = await ready('host-a', { originalLanguage });
      expect((await played(app)).session.audio_lang).toBeNull();
    }
    expect((await calls()).filter((c) => c.includes('--audio-lang'))).toEqual([]);
  });
});

describe('the pass-through', () => {
  it('fetches the master playlist with the captured headers and rewrites every address in it', async () => {
    const { app } = await ready();
    const { session } = await played(app);
    const sid = session.session_id;
    const res = await app.request(session.manifest_url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    expect(res.headers.get('x-notesd-upstream')).toBe('200');
    expect((await res.text()).split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="${through(sid, `${up.origin}/hls/subs/en.m3u8`)}"`,
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,SUBTITLES="subs"',
      through(sid, `${up.origin}/hls/720/index.m3u8`),
      '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1920x1080,SUBTITLES="subs"',
      through(sid, `${up.altOrigin}/hls/1080/index.m3u8`),
      '',
    ]);
    expect(up.requests.at(-1)).toMatchObject({
      path: '/hls/master.m3u8', referer: 'https://embed.fixture/', origin: 'https://embed.fixture', user_agent: 'FixtureChrome/1.0', cookie: null, range: null,
    });
    const media = await (await app.request(through(sid, `${up.origin}/hls/720/index.m3u8`))).text();
    expect(media).toContain(`#EXT-X-MAP:URI="${through(sid, `${up.origin}/hls/720/init.mp4`)}"`);
    expect(media).toContain(through(sid, `${up.origin}/hls/720/seg1.ts`));
    expect(media).toContain(through(sid, `${up.origin}/hls/720/seg2.ts`));
  });

  it('allows a host only after a playlist fetched through the session named it', async () => {
    const { app } = await ready();
    const { session } = await played(app);
    const alt = through(session.session_id, `${up.altOrigin}/hls/1080/index.m3u8`);
    const before = up.requests.length;
    const refused = await app.request(alt);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe('forbidden_host');
    expect(refused.headers.get('x-notesd-upstream')).toBeNull();
    expect(up.requests.length).toBe(before);
    await (await app.request(session.manifest_url)).text();
    expect((await app.request(alt)).status).toBe(200);
  });

  it('forwards Range and streams the segment back', async () => {
    const { app } = await ready();
    const { session } = await played(app);
    const res = await app.request(through(session.session_id, `${up.origin}/hls/720/seg1.ts`), { headers: { range: 'bytes=0-99' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-99/1000');
    expect((await res.arrayBuffer()).byteLength).toBe(100);
    expect(up.requests.at(-1)?.range).toBe('bytes=0-99');
  });

  it('answers 403 and fetches nothing for an unknown session, an ended one, or a host the resolve did not return', async () => {
    const { app } = await ready();
    const { session } = await played(app);
    const sid = session.session_id;
    const before = up.requests.length;
    const errorOf = async (p: string): Promise<[number, string]> => {
      const res = await app.request(p);
      return [res.status, ((await res.json()) as { error: string }).error];
    };
    expect(await errorOf(through('A'.repeat(32), `${up.origin}/hls/master.m3u8`))).toEqual([403, 'unknown_session']);
    expect(await errorOf(through('nope', `${up.origin}/hls/master.m3u8`))).toEqual([403, 'unknown_session']);
    expect(await errorOf(through(sid, 'http://evil.example/x.m3u8'))).toEqual([403, 'forbidden_host']);
    expect(await errorOf(through(sid, 'http://127.0.0.1:9/x.m3u8'))).toEqual([403, 'forbidden_host']);
    expect(await errorOf(through(sid, 'file:///etc/passwd'))).toEqual([403, 'forbidden_host']);
    expect(await errorOf(`/api/stream/sessions/${sid}/p`)).toEqual([403, 'forbidden_host']);
    expect(await errorOf(`/api/stream/sessions/${'A'.repeat(32)}`)).toEqual([403, 'unknown_session']);
    clock = new Date(clock.getTime() + SESSION_IDLE_MS);
    expect(await errorOf(session.manifest_url)).toEqual([403, 'unknown_session']);
    expect(await errorOf(`/api/stream/sessions/${sid}`)).toEqual([403, 'unknown_session']);
    expect(up.requests.length).toBe(before);
  });

  it('rewrites a DASH manifest and keeps the template fields for the player', async () => {
    const { app } = await ready();
    await mode('dash');
    const { session } = await played(app);
    const sid = session.session_id;
    expect(session.manifest_kind).toBe('dash');
    const res = await app.request(session.manifest_url);
    expect(res.headers.get('content-type')).toBe('application/dash+xml');
    const mpd = await res.text();
    const prefix = `/api/stream/sessions/${sid}/p?u=`;
    const base = encodeURIComponent(`${up.altOrigin}/dash/`);
    expect(mpd).toContain(`<BaseURL>${through(sid, `${up.altOrigin}/dash/`)}</BaseURL>`);
    expect(mpd).toContain(`<BaseURL>${through(sid, `${up.altOrigin}/dash/audio/a1.mp4`)}</BaseURL>`);
    expect(mpd).toContain(`media="${prefix}${base}$RepresentationID$${encodeURIComponent('/seg-')}$Number%05d$${encodeURIComponent('.m4s')}"`);
    expect(mpd).not.toContain('http://');
    const segment = `${prefix}${base}v720${encodeURIComponent('/seg-')}00001${encodeURIComponent('.m4s')}`;
    const seg = await app.request(segment);
    expect(seg.status).toBe(200);
    expect((await seg.arrayBuffer()).byteLength).toBe(1000);
  });

  it('serves an .srt track as WebVTT', async () => {
    const { app } = await ready();
    const { session } = await played(app);
    const res = await app.request(session.subtitles[0]?.url ?? '');
    expect(res.headers.get('content-type')).toBe('text/vtt; charset=utf-8');
    expect(await res.text()).toBe('WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nHello.\n');
  });

  it('forwards the stream host status of an expired token, marked as the host answer', async () => {
    const { app } = await ready();
    const { session } = await played(app);
    const res = await app.request(through(session.session_id, `${up.origin}/expired.m3u8`));
    expect(res.status).toBe(410);
    expect(res.headers.get('x-notesd-upstream')).toBe('410');
  });
});

describe('POST /api/stream/sessions/:id/refresh', () => {
  it('resolves again under the same id; a failed refresh leaves the session working', async () => {
    const { app } = await ready();
    const { session } = await played(app);
    const sid = session.session_id;
    clock = new Date(clock.getTime() + 60_000);
    const res = await app.request(`/api/stream/sessions/${sid}/refresh`, { method: 'POST', headers: SAME_ORIGIN });
    expect(res.status).toBe(200);
    const info = (await res.json()) as SessionInfo;
    expect(info.session_id).toBe(sid);
    expect(info.refreshed_at).toBe('2026-11-15T12:01:00.000Z');
    expect((await calls()).map((a) => a[0])).toEqual(['resolve', 'open', 'resolve']);
    await mode('no_source');
    const failed = await app.request(`/api/stream/sessions/${sid}/refresh`, { method: 'POST', headers: SAME_ORIGIN });
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { error: string }).error).toBe('no_source');
    expect((await app.request(session.manifest_url)).status).toBe(200);
    const unknown = await app.request(`/api/stream/sessions/${'A'.repeat(32)}/refresh`, { method: 'POST', headers: SAME_ORIGIN });
    expect(unknown.status).toBe(403);
  });
});

describe('POST /api/stream/play with a provider', () => {
  it('asks only the named provider, and says so when there is none of that name', async () => {
    const { app } = await ready();
    const { session } = await played(app, { kind: 'movie', tmdb_id: 550, provider: 'Alpha' });
    expect(session.provider).toBe('Alpha');
    expect((await calls())[0]).toEqual(expect.arrayContaining(['resolve', '--only', 'Alpha']));
    expect((await play(app, { kind: 'movie', tmdb_id: 550, provider: '' })).status).toBe(400);
  });
});

describe('POST /api/stream/sessions/:id/source', () => {
  const source = (app: Hono, sid: string) => app.request(`/api/stream/sessions/${sid}/source`, { method: 'POST', headers: SAME_ORIGIN });
  type SourceJson = SessionInfo & { switched: boolean; reason: string | null; from: string };

  it('moves the session to another provider under the same id, never back, and keeps it when there is none left', async () => {
    const { app } = await ready();
    const { session } = await played(app);
    const sid = session.session_id;
    expect(session.provider).toBe('Bravo');
    records = [];
    const res = await source(app, sid);
    expect(res.status).toBe(200);
    const moved = (await res.json()) as SourceJson;
    expect(moved).toMatchObject({ session_id: sid, provider: 'Alpha', switched: true, reason: null, from: 'Bravo' });
    expect((await calls()).at(-1)).toEqual(expect.arrayContaining(['resolve', '--skip', 'Bravo']));
    // The move is a resolve that found a source: the title's source is recorded.
    expect(records.map((r) => r.result.ok)).toEqual([true]);
    expect((await app.request(moved.manifest_url)).status).toBe(200);

    // A token refresh after the move does not go back to the provider it left.
    const refreshed = await app.request(`/api/stream/sessions/${sid}/refresh`, { method: 'POST', headers: SAME_ORIGIN });
    expect(((await refreshed.json()) as SessionInfo).provider).toBe('Alpha');
    expect((await calls()).at(-1)).toEqual(expect.arrayContaining(['--skip', 'Bravo']));

    records = [];
    const again = (await (await source(app, sid)).json()) as SourceJson;
    expect(again).toMatchObject({ session_id: sid, provider: 'Alpha', switched: false, reason: 'no_other_source', from: 'Alpha' });
    expect((await calls()).at(-1)).toEqual(expect.arrayContaining(['--skip', 'Bravo,Alpha']));
    // Nothing found: the title is not marked stale while it plays.
    expect(records).toEqual([]);
    expect((await app.request(moved.manifest_url)).status).toBe(200);
  });

  it('is same-origin only and answers unknown_session for an ended one', async () => {
    const { app } = await ready();
    const { session } = await played(app);
    const cross = await app.request(`/api/stream/sessions/${session.session_id}/source`, { method: 'POST', headers: { origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
    expect((await source(app, 'A'.repeat(32))).status).toBe(403);
  });

  it('hands the resolver each provider\'s delivery from the evidence log, and shows it with the providers', async () => {
    const kept: EvidenceRecord[] = [];
    const sink: EvidenceSink = {
      record: (input: EvidenceInput) => {
        kept.push({ ...input, at: clock.toISOString() } as EvidenceRecord);
      },
      recent: async () => kept,
    };
    const svc = service('host-a', {}, sink);
    await svc.syncSeed();
    const app = appFor(svc);
    for (let i = 0; i < 20; i++) {
      sink.record({
        type: 'request', session: 'x'.repeat(32), provider: 'Bravo', stream_host: 'cdn.example', path: '/s.ts', range: null, kind: 'media',
        status: 503, answer: 503, ttfb_ms: 100, bytes: 190, duration_ms: 300, kbps: null, redirects: 0, outcome: 'end', error: null,
      });
    }
    await played(app);
    const call = JSON.parse((await readFile(path.join(fakeDir, 'calls.jsonl'), 'utf8')).trim().split('\n')[0] ?? '{}') as { bad_delivery?: string[] };
    expect(call.bad_delivery).toEqual(['Bravo']);
    const shown = await svc.providers();
    expect(shown.find((p) => p.name === 'Bravo')?.delivery).toMatchObject({ verdict: 'bad', requests: 20, failed: 20 });
    expect(shown.find((p) => p.name === 'Alpha')?.delivery).toBeNull();
  });
});

describe('direct_stream_off', () => {
  it('answers direct_stream_off on every route without the service, before any other check', async () => {
    const app = appFor(null);
    const id = 'A'.repeat(32);
    const routes: [string, string][] = [
      ['POST', '/api/stream/play'],
      ['GET', `/api/stream/sessions/${id}`],
      ['GET', `/api/stream/sessions/${id}/p?u=${encodeURIComponent(`${up.origin}/hls/master.m3u8`)}`],
      ['POST', `/api/stream/sessions/${id}/refresh`],
      ['POST', `/api/stream/sessions/${id}/source`],
    ];
    for (const [method, p] of routes) {
      const res = await app.request(p, method === 'POST' ? { method, headers: { 'content-type': 'application/json' }, body: '{"kind":"movie","tmdb_id":550}' } : { method });
      expect([method, p, res.status]).toEqual([method, p, 503]);
      expect(((await res.json()) as { error: string }).error).toBe('direct_stream_off');
    }
    expect(await calls()).toEqual([]);
    expect(up.requests).toHaveLength(0);
  });
});
