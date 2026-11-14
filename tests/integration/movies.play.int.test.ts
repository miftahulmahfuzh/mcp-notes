import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { moviePlays } from '../../src/db/schema.js';
import { moviesPlayRoutes } from '../../src/http/moviesPlayApi.js';
import { revealRoutes, type RevealDeps } from '../../src/http/reveal.js';
import { MoviePlayer } from '../../src/movies/player.js';
import { MoviesRepo } from '../../src/movies/repo.js';
import { curlStatusReader } from '../../src/movies/vlc/http.js';
import { spawnVlcLauncher, type PlayerDetection } from '../../src/movies/vlc/launch.js';
import { createApiHarness, SAME_ORIGIN, type ApiHarness } from './helpers/api-harness.js';
import { seedFile, seedPlay, seedTitle, truncateMovies } from './helpers/moviesPlaySeed.js';

const CURL = '/usr/bin/curl';
const FAKE_VLC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/movies/fake-vlc.mjs');
const HOST = 'this-host';
const NO_REVEAL: RevealDeps = { detect: async () => null, wslpath: async (p) => p, spawn: async () => undefined };

interface Launch {
  pid: number;
  argv: string[];
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function freePortBlock(n: number): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 40000 + Math.floor(Math.random() * 20000);
    let ok = true;
    for (let i = 0; i < n && ok; i++) ok = await portFree(base + i);
    if (ok) return base;
  }
  throw new Error('no free block of ports');
}

function argOf(argv: string[], name: string): string {
  return argv[argv.indexOf(name) + 1]!;
}

describe.skipIf(!existsSync(CURL))('movies playback with a fake VLC', () => {
  let h: ApiHarness;
  let dir: string;
  let log: string;
  let basePort: number;
  const players: MoviePlayer[] = [];

  async function launches(): Promise<Launch[]> {
    try {
      return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Launch);
    } catch {
      return [];
    }
  }

  async function vlcBin(extra: Record<string, string> = {}): Promise<string> {
    const env = { FAKE_VLC_LOG: log, FAKE_VLC_SPEED: '60', FAKE_VLC_LIFE_MS: '30000', ...extra };
    const bin = path.join(dir, `vlc-${Object.keys(extra).join('-') || 'default'}.exe`);
    const lines = Object.entries(env).map(([k, v]) => `export ${k}='${v}'`);
    await writeFile(bin, `#!/bin/sh\n${lines.join('\n')}\nexec "${process.execPath}" "${FAKE_VLC}" "$@"\n`);
    await chmod(bin, 0o755);
    return bin;
  }

  async function makePlayer(o: { detection?: PlayerDetection; vlcEnv?: Record<string, string>; readyTimeoutMs?: number } = {}): Promise<MoviePlayer> {
    const vlc = await vlcBin(o.vlcEnv);
    const player = new MoviePlayer({
      repo: new MoviesRepo(h.deps.db),
      host: HOST,
      httpPort: basePort,
      pollMs: 100,
      detect: async () => o.detection ?? { available: true, env: { vlc, curl: CURL, wslpath: '/usr/bin/wslpath' } },
      launcher: spawnVlcLauncher({ scope: false }),
      reader: curlStatusReader(),
      wslpath: async (_bin, abs) => `C:\\fake\\${path.basename(abs)}`,
      readyTimeoutMs: o.readyTimeoutMs ?? 5000,
      readyIntervalMs: 50,
      playingTimeoutMs: 2000,
      log: () => {},
    });
    players.push(player);
    return player;
  }

  function appFor(player: MoviePlayer | null): Hono {
    const app = new Hono();
    app.route('/', moviesPlayRoutes({ db: h.deps.db, moviesPlayer: player }));
    app.route('/', revealRoutes({ ...h.deps, moviesPlayer: player }, { reveal: NO_REVEAL }));
    return app;
  }

  async function post(app: Hono, url: string, body?: unknown): Promise<Response> {
    return app.request(url, {
      method: 'POST',
      headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function playRow(id: number) {
    const [row] = await h.deps.db.select().from(moviePlays).where(eq(moviePlays.id, id));
    return row!;
  }

  async function fakeStatus(port: number, password: string): Promise<{ state: string; time: number }> {
    const res = await fetch(`http://127.0.0.1:${port}/requests/status.json`, {
      headers: { authorization: 'Basic ' + Buffer.from(':' + password).toString('base64') },
    });
    return (await res.json()) as { state: string; time: number };
  }

  async function seedFilm(o: { lastPosition?: number; host?: string } = {}): Promise<number> {
    await seedTitle(h.deps.db, { id: 'movie-900001', kind: 'movie', tmdbId: 900001, title: 'Fake Film', year: 2026 }).catch(() => undefined);
    const file = path.join(dir, `Fake.Film.2026.${Math.random().toString(36).slice(2)}.mkv`);
    await writeFile(file, 'x');
    const fileId = await seedFile(h.deps.db, { titleId: 'movie-900001', host: o.host ?? HOST, path: file, durationS: 7200 });
    if (o.lastPosition !== undefined) {
      await seedPlay(h.deps.db, { fileId, host: o.host ?? HOST, positionS: o.lastPosition, durationS: 7200, startedAt: new Date(Date.now() - 86_400_000) });
    }
    return fileId;
  }

  beforeAll(async () => {
    h = await createApiHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await truncateMovies(h.deps.db);
    dir = await mkdtemp(path.join(os.tmpdir(), 'movies-play-'));
    log = path.join(dir, 'launches.jsonl');
    basePort = await freePortBlock(3);
  });
  afterEach(async () => {
    for (const p of players.splice(0)) await p.close();
    for (const l of await launches()) {
      try {
        process.kill(l.pid);
      } catch {
        // already exited
      }
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('starts VLC at the last recorded position and seeks there (R4.1)', async () => {
    const app = appFor(await makePlayer());
    const fileId = await seedFilm({ lastPosition: 1200 });
    const res = await post(app, `/api/movies/files/${fileId}/play`);
    expect(res.status).toBe(202);
    const { play } = (await res.json()) as { play: { play_id: number; start_position: number; tracking: boolean; port: number } };
    expect(play).toMatchObject({ start_position: 1200, tracking: true, port: basePort });
    const [launch] = await launches();
    expect(launch!.argv).toEqual([
      '--no-one-instance',
      '--no-one-instance-when-started-from-file',
      '--qt-continue=0',
      '--no-qt-privacy-ask',
      '--extraintf',
      'http',
      '--http-host',
      '127.0.0.1',
      '--http-port',
      String(basePort),
      '--http-password',
      expect.stringMatching(/^[0-9a-f]{32}$/),
      '--start-time=1200',
      expect.stringMatching(/^C:\\fake\\Fake\.Film\.2026\..+\.mkv$/),
    ]);
    // The fake ignores --start-time and starts stopped: playing at >= 1200 proves pl_play + seek.
    const st = await fakeStatus(basePort, argOf(launch!.argv, '--http-password'));
    expect(st.state).toBe('playing');
    expect(st.time).toBeGreaterThanOrEqual(1200);
  });

  it('starts a finished file from the beginning (R4.1)', async () => {
    const app = appFor(await makePlayer());
    const fileId = await seedFilm({ lastPosition: 7000 });
    const res = await post(app, `/api/movies/files/${fileId}/play`);
    expect(res.status).toBe(202);
    expect(((await res.json()) as { play: { start_position: number } }).play.start_position).toBe(0);
    const [launch] = await launches();
    expect(launch!.argv).toContain('--start-time=0');
    expect((await fakeStatus(basePort, argOf(launch!.argv, '--http-password'))).time).toBeLessThan(600);
  });

  it('records position and duration into the play every poll while VLC plays (R4.2)', async () => {
    const app = appFor(await makePlayer());
    const fileId = await seedFilm({ lastPosition: 1200 });
    const { play } = (await (await post(app, `/api/movies/files/${fileId}/play`)).json()) as { play: { play_id: number } };
    await vi.waitFor(
      async () => {
        const row = await playRow(play.play_id);
        expect(row.positionS).toBeGreaterThan(1260);
        expect(row.durationS).toBe(7200);
        expect(row.endedAt).toBeNull();
      },
      { timeout: 5000, interval: 100 },
    );
    const state = (await (await app.request('/api/movies/player')).json()) as { available: boolean; current: { play_id: number; state: string } | null };
    expect(state).toMatchObject({ available: true, current: { play_id: play.play_id, state: 'playing' } });
  });

  it('closes the play at the last position read when VLC exits (R4.3)', async () => {
    const app = appFor(await makePlayer());
    const fileId = await seedFilm({ lastPosition: 1200 });
    const { play } = (await (await post(app, `/api/movies/files/${fileId}/play`)).json()) as { play: { play_id: number } };
    await vi.waitFor(async () => expect((await playRow(play.play_id)).positionS).toBeGreaterThan(1260), { timeout: 5000, interval: 100 });
    const before = (await playRow(play.play_id)).positionS!;
    await fetch(`http://127.0.0.1:${basePort}/fake/quit`);
    await vi.waitFor(async () => expect((await playRow(play.play_id)).endedAt).not.toBeNull(), { timeout: 5000, interval: 100 });
    const row = await playRow(play.play_id);
    expect(row.positionS).toBeGreaterThanOrEqual(before);
    expect(row.positionS).toBeLessThan(before + 120);
    expect(((await (await app.request('/api/movies/player')).json()) as { current: unknown }).current).toBeNull();
  });

  it('answers not_on_this_machine for a file of another host and starts nothing (R3.7)', async () => {
    const app = appFor(await makePlayer());
    const fileId = await seedFilm({ host: 'other-laptop', lastPosition: 100 });
    const res = await post(app, `/api/movies/files/${fileId}/play`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_on_this_machine', host: 'other-laptop' });
    expect(await launches()).toEqual([]);
  });

  it('answers player_unavailable and reports playback off when vlc.exe is missing (R4.5)', async () => {
    const off = appFor(await makePlayer({ detection: { available: false, reason: 'no_vlc' } }));
    const fileId = await seedFilm();
    const res = await post(off, `/api/movies/files/${fileId}/play`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'player_unavailable', reason: 'no_vlc' });
    expect(await (await off.request('/api/capabilities')).json()).toEqual({ reveal: false, movies_playback: false });
    expect(await (await off.request('/api/movies/player')).json()).toEqual({ available: false, reason: 'no_vlc', current: null });
    expect(await launches()).toEqual([]);
    const on = appFor(await makePlayer());
    expect(await (await on.request('/api/capabilities')).json()).toEqual({ reveal: false, movies_playback: true });
    const none = appFor(null);
    expect((await post(none, `/api/movies/files/${fileId}/play`)).status).toBe(503);
  });

  it('a new play ends tracking of the previous one, leaves that VLC running and takes the next port', async () => {
    const app = appFor(await makePlayer());
    const a = await seedFilm({ lastPosition: 100 });
    const b = await seedFilm({ lastPosition: 200 });
    const first = ((await (await post(app, `/api/movies/files/${a}/play`)).json()) as { play: { play_id: number } }).play;
    const second = ((await (await post(app, `/api/movies/files/${b}/play`)).json()) as { play: { play_id: number; port: number } }).play;
    expect(second.port).toBe(basePort + 1);
    expect((await playRow(first.play_id)).endedAt).not.toBeNull();
    const [launchA] = await launches();
    expect((await fakeStatus(basePort, argOf(launchA!.argv, '--http-password'))).state).toBe('playing');
  });

  it('ends the play untracked when the HTTP interface never comes up', async () => {
    const app = appFor(await makePlayer({ vlcEnv: { FAKE_VLC_NO_HTTP: '1' }, readyTimeoutMs: 600 }));
    const fileId = await seedFilm({ lastPosition: 900 });
    const res = await post(app, `/api/movies/files/${fileId}/play`);
    expect(res.status).toBe(202);
    const { play } = (await res.json()) as { play: { play_id: number; tracking: boolean; note: string } };
    expect(play).toMatchObject({ tracking: false, note: 'http_timeout' });
    const row = await playRow(play.play_id);
    expect(row.endedAt).not.toBeNull();
    expect(row.positionS).toBe(900);
  });

  it('close() ends the play at its last position and leaves VLC open; start() closes a play left open', async () => {
    const player = await makePlayer();
    const app = appFor(player);
    const fileId = await seedFilm({ lastPosition: 1200 });
    const { play } = (await (await post(app, `/api/movies/files/${fileId}/play`)).json()) as { play: { play_id: number } };
    await vi.waitFor(async () => expect((await playRow(play.play_id)).positionS).toBeGreaterThan(1260), { timeout: 5000, interval: 100 });
    await player.close();
    const closed = await playRow(play.play_id);
    expect(closed.endedAt).not.toBeNull();
    const [launch] = await launches();
    expect((await fakeStatus(basePort, argOf(launch!.argv, '--http-password'))).state).toBe('playing');

    const stale = await seedPlay(h.deps.db, { fileId, host: HOST, positionS: 500, durationS: 7200, startedAt: new Date('2026-11-13T10:00:00Z'), endedAt: null });
    const restarted = await makePlayer();
    expect(await restarted.start()).toBe(1);
    const row = await playRow(stale);
    expect(row.positionS).toBe(500);
    expect(row.endedAt?.toISOString()).toBe('2026-11-13T10:00:00.000Z');
  });

  it('answers file_missing for a deleted file, and refuses a foreign Origin', async () => {
    const app = appFor(await makePlayer());
    const gone = await seedFile(h.deps.db, { titleId: null, host: HOST, path: path.join(dir, 'gone.mkv'), deletedAt: new Date() });
    expect((await post(app, `/api/movies/files/${gone}/play`)).status).toBe(410);
    const res = await app.request(`/api/movies/files/${gone}/play`, { method: 'POST', headers: { origin: 'http://evil.example' } });
    expect(res.status).toBe(403);
    expect((await post(app, '/api/movies/files/abc/play')).status).toBe(400);
  });
});
