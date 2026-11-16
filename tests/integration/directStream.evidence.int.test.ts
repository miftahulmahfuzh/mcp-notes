import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { StreamEvidence, type EvidenceRecord } from '../../src/directStream/evidence.js';
import { DirectStreamRepo } from '../../src/directStream/repo.js';
import { directStreamScriptRunner } from '../../src/directStream/runner.js';
import { DirectStreamService, type SessionInfo } from '../../src/directStream/service.js';
import { directStreamRoutes } from '../../src/http/directStreamApi.js';
import { streamEvidenceRoutes } from '../../src/http/streamEvidenceApi.js';
// @ts-expect-error -- plain .mjs fixture without type declarations
import { startUpstream } from '../fixtures/direct-stream/upstream.mjs';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/direct-stream');
const FAKE_CLI = path.join(FIXTURES, 'fake-cli.mjs');
const SAME_ORIGIN = { origin: 'http://localhost' };
const SEED = [
  { name: 'Alpha', movie: 'https://alpha.example/movie/{id}', en_subtitle: true },
  { name: 'Bravo', movie: 'https://bravo.example/movie/{id}', tv: 'https://bravo.example/tv/{id}/{season}/{episode}' },
];

interface Upstream {
  origin: string;
  altOrigin: string;
  requests: unknown[];
  close(): Promise<void>;
}

let db: Db;
let up: Upstream;
let fakeDir: string;
let dataDir: string;
let evidence: StreamEvidence;
let app: Hono;

const through = (sid: string, u: string): string => `/api/stream/sessions/${sid}/p?u=${encodeURIComponent(u)}`;
const post = (p: string, body: unknown, headers: Record<string, string> = SAME_ORIGIN): Promise<Response> =>
  Promise.resolve(app.request(p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));

async function play(): Promise<SessionInfo> {
  const res = await post('/api/stream/play', { kind: 'movie', tmdb_id: 550 });
  expect(res.status).toBe(200);
  return ((await res.json()) as { session: SessionInfo }).session;
}

async function records(query: string): Promise<EvidenceRecord[]> {
  const res = await app.request(`/api/stream/evidence?${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { records: EvidenceRecord[] }).records;
}

beforeAll(async () => {
  db = openTestDb();
  up = (await startUpstream()) as Upstream;
  fakeDir = await mkdtemp(path.join(os.tmpdir(), 'direct-stream-evidence-'));
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
  await writeFile(path.join(fakeDir, 'mode'), 'hls\n');
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'direct-stream-evidence-data-'));
  let svc: DirectStreamService | null = null;
  evidence = new StreamEvidence({ dir: dataDir, host: 'host-a', source: (id) => svc?.evidenceSource(id) ?? null });
  svc = new DirectStreamService({
    repo: new DirectStreamRepo(db),
    runner: directStreamScriptRunner({ cliPath: FAKE_CLI }),
    host: 'host-a',
    seedFile: path.join(fakeDir, 'seed.json'),
    pageBase: () => 'http://localhost:4321',
    evidence,
    log: () => undefined,
  });
  await svc.syncSeed();
  app = new Hono();
  app.route('/', directStreamRoutes({ directStream: svc }));
  app.route('/', streamEvidenceRoutes({ directStream: svc, streamEvidence: evidence }));
});

describe('the evidence log through the real pass-through (R2.1)', () => {
  it('records every answer with host and path, never the query, and an ended session as refused', async () => {
    const session = await play();
    const sid = session.session_id;
    expect((await app.request(session.manifest_url)).status).toBe(200);
    await (await app.request(session.manifest_url)).text();
    const seg = await app.request(through(sid, `${up.origin}/hls/720/seg1.ts?token=SECRET123`), { headers: { range: 'bytes=0-99' } });
    expect(seg.status).toBe(206);
    expect((await seg.arrayBuffer()).byteLength).toBe(100);
    const gone = 'A'.repeat(32);
    expect((await app.request(through(gone, `${up.origin}/hls/master.m3u8`))).status).toBe(403);

    const mine = await records(`session=${sid}&limit=50`);
    const host = new URL(up.origin).host;
    expect(mine.filter((r) => r.type === 'session')).toEqual([expect.objectContaining({ event: 'created', provider: session.provider, stream_host: host })]);
    const reqs = mine.filter((r) => r.type === 'request');
    expect(reqs.find((r) => r.path === '/hls/master.m3u8')).toMatchObject({ kind: 'hls', status: 200, answer: 200, outcome: 'end', stream_host: host, provider: session.provider });
    const segRec = reqs.find((r) => r.path === '/hls/720/seg1.ts');
    expect(segRec).toMatchObject({ kind: 'media', status: 206, answer: 206, bytes: 100, range: 'bytes=0-99', outcome: 'end' });
    expect(typeof (segRec as { ttfb_ms: unknown }).ttfb_ms).toBe('number');
    expect(typeof (segRec as { kbps: unknown }).kbps).toBe('number');
    expect(await records(`session=${gone}`)).toEqual([expect.objectContaining({ type: 'request', outcome: 'refused', answer: 403, error: 'unknown_session' })]);
    const onDisk = await readFile(evidence.file, 'utf8');
    expect(onDisk).not.toContain('SECRET123');
    expect(onDisk).not.toContain('FixtureChrome');
  });
});

describe('the page log (R2.2)', () => {
  it('appends posted lines under the session id, queries cut off; same-origin only', async () => {
    const session = await play();
    const sid = session.session_id;
    const line = { text: `error: networkError fragLoadError ${through(sid, `${up.origin}/hls/720/seg1.ts?token=SECRET9`)}`, stage: 'error', position_s: 61.2, buffer_s: 0, at: '2026-11-16T05:58:45.000Z' };
    expect((await post(`/api/stream/sessions/${sid}/events`, { lines: [line] }, {})).status).toBe(403);
    const res = await post(`/api/stream/sessions/${sid}/events`, { lines: [line] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recorded: 1 });
    const player = (await records(`session=${sid}`)).filter((r) => r.type === 'player');
    expect(player).toEqual([
      expect.objectContaining({ text: `error: networkError fragLoadError /api/stream/sessions/${sid}/p`, stage: 'error', position_s: 61.2, buffer_s: 0, page_at: line.at }),
    ]);
    expect((await post(`/api/stream/sessions/${sid}/events`, { lines: [] })).status).toBe(400);
    expect(((await (await post('/api/stream/sessions/nope/events', { lines: [line] })).json()) as { error: string }).error).toBe('invalid_session');
  });
});

describe('snapshot (R2.3)', () => {
  it("writes the live session's source, its records and the page's lines into one new folder", async () => {
    const session = await play();
    const sid = session.session_id;
    await (await app.request(session.manifest_url)).text();
    expect((await post(`/api/stream/sessions/${sid}/events`, { lines: [{ text: 'refresh after 403 at 100 s', stage: 'refreshing' }] })).status).toBe(200);
    expect((await post(`/api/stream/sessions/${sid}/refresh`, {})).status).toBe(200);
    expect((await post('/api/stream/evidence/snapshot', { session_id: sid }, {})).status).toBe(403);

    const res = await post('/api/stream/evidence/snapshot', { session_id: sid });
    expect(res.status).toBe(200);
    const snap = (await res.json()) as { ok: true; dir: string; session_id: string; complete: boolean; records: number; player_lines: number };
    expect(snap).toMatchObject({ ok: true, session_id: sid, complete: true, player_lines: 1 });
    expect(path.dirname(snap.dir)).toBe(path.join(dataDir, 'stream-reports'));
    expect(path.basename(snap.dir)).toMatch(new RegExp(`^\\d{8}-\\d{6}-${sid.slice(0, 6).replace(/[-_]/g, '\\$&')}$`));
    expect((await readdir(snap.dir)).sort()).toEqual(['evidence.jsonl', 'player.json', 'session.json']);
    const sessionJson = JSON.parse(await readFile(path.join(snap.dir, 'session.json'), 'utf8')) as {
      live: boolean;
      source: { provider: string; attempts: unknown[]; hosts: string[]; refreshes: number; captured_headers: string[] };
      sessions: { event: string }[];
    };
    expect(sessionJson.live).toBe(true);
    expect(sessionJson.source.provider).toBe(session.provider);
    expect(sessionJson.source.attempts).toHaveLength(2);
    expect(sessionJson.source.hosts).toContain(new URL(up.origin).host);
    expect(sessionJson.source.refreshes).toBe(1);
    expect(sessionJson.source.captured_headers).toEqual(['referer', 'origin', 'user_agent']);
    expect(sessionJson.sessions.map((s) => s.event)).toEqual(['created', 'refreshed']);
    const trail = (await readFile(path.join(snap.dir, 'evidence.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { session: string; type: string });
    expect(trail.every((r) => r.session === sid && r.type !== 'player')).toBe(true);
    expect(trail.some((r) => r.type === 'request')).toBe(true);
    const files = await Promise.all((await readdir(snap.dir)).map((f) => readFile(path.join(snap.dir, f), 'utf8')));
    expect(files.join('\n')).not.toContain('FixtureChrome');
    expect(files.join('\n')).not.toContain('https://embed.fixture/');

    const ended = (await (await post('/api/stream/evidence/snapshot', { session_id: 'B'.repeat(32) })).json()) as { complete: boolean; records: number };
    expect(ended).toMatchObject({ complete: false, records: 0 });
    const newest = (await (await post('/api/stream/evidence/snapshot', {})).json()) as { session_id: string };
    expect(newest.session_id).toBe(sid);
    expect((await post('/api/stream/evidence/snapshot', { session_id: 'bad' })).status).toBe(400);
  });
});

describe('GET /api/stream/evidence', () => {
  it('validates its query and keeps the newest records', async () => {
    const session = await play();
    await (await app.request(session.manifest_url)).text();
    expect((await app.request('/api/stream/evidence?limit=0')).status).toBe(400);
    expect((await app.request('/api/stream/evidence?limit=2001')).status).toBe(400);
    expect((await app.request('/api/stream/evidence?session=bad')).status).toBe(400);
    const one = await records('limit=1');
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ type: 'request', path: '/hls/master.m3u8' });
  });

  it('answers direct_stream_off without direct streaming', async () => {
    const off = new Hono();
    off.route('/', directStreamRoutes({ directStream: null }));
    off.route('/', streamEvidenceRoutes({ directStream: null, streamEvidence: null }));
    expect((await off.request('/api/stream/evidence')).status).toBe(503);
    const sid = 'A'.repeat(32);
    expect((await off.request(`/api/stream/sessions/${sid}/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...SAME_ORIGIN }, body: '{"lines":[{"text":"x"}]}' })).status).toBe(503);
    expect((await off.request('/api/stream/evidence/snapshot', { method: 'POST', headers: SAME_ORIGIN, body: '{}' })).status).toBe(503);
  });
});
