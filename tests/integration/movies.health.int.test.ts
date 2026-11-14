import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOVIES_CONFIG, type MoviesConfig } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { moviePlays } from '../../src/db/schema.js';
import { moviesPlayRoutes } from '../../src/http/moviesPlayApi.js';
import { nodeProbe, WSL_INTEROP_FILES, type DetectProbe } from '../../src/http/reveal.js';
import { buildMoviePlayback, type MoviePlayer, type PlaybackService, type PlayStarted } from '../../src/movies/player.js';
import { MoviesRepo } from '../../src/movies/repo.js';
import {
  HealthMonitor,
  parseHealthLine,
  type HangRecord,
  type HealthRecord,
  type HealthReport,
  type ProcessLister,
  type SampleRecord,
  type VlcProcess,
} from '../../src/movies/vlc/health.js';
import { seedFile, seedTitle, truncateMovies } from './helpers/moviesPlaySeed.js';
import { closeTestDb, openTestDb } from './setup.js';

const execFileAsync = promisify(execFile);
const CURL = '/usr/bin/curl';
const FAKE_VLC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/movies/fake-vlc.mjs');
const HOST = 'health-host';
const EXTRA = ['--avcodec-hw=none', '--no-video-title-show'];

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
  return argv[argv.indexOf(name) + 1] ?? '';
}

/** Alive and not a zombie (an exited, unreaped child still answers kill -0). */
function alive(pid: number): boolean {
  try {
    return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
}

/** "Windows" as the health monitor sees it: every fake VLC launch still running, with its argv as the command line. */
function launchLogLister(logFile: string): ProcessLister {
  return {
    async list() {
      let text = '';
      try {
        text = await readFile(logFile, 'utf8');
      } catch {
        text = '';
      }
      const processes: VlcProcess[] = [];
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        const l = JSON.parse(line) as Launch;
        if (!alive(l.pid)) continue;
        processes.push({
          pid: l.pid,
          wsBytes: 300_000_000,
          privateBytes: 400_000_000,
          handles: 900,
          startedAt: null,
          commandLine: `"C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" ${l.argv.join(' ')}`,
        });
      }
      return { kind: 'ok', detail: true, processes };
    },
  };
}

/** WSL as detectPlayerEnv needs it, on any Linux: interop "registered", wslpath "on PATH", real files otherwise. */
function wslProbe(): DetectProbe {
  const real = nodeProbe();
  const interop: readonly string[] = WSL_INTEROP_FILES;
  return {
    platform: 'linux',
    env: { PATH: '/usr/bin:/bin' },
    exists: async (p) => interop.includes(p) || real.exists(p),
    executable: async (p) => p === '/usr/bin/wslpath' || real.executable(p),
  };
}

describe.skipIf(!existsSync(CURL))('VLC health with a fake VLC over curl', () => {
  let db: Db;
  let dir: string;
  let launchLog: string;
  let player: MoviePlayer;
  let monitor: HealthMonitor;
  let app: Hono;
  let fileId: number;
  let started: PlayStarted;
  let launch: Launch;
  let port: number;
  let position: number;

  async function launches(): Promise<Launch[]> {
    try {
      return (await readFile(launchLog, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Launch);
    } catch {
      return [];
    }
  }

  function records(): HealthRecord[] {
    try {
      return readFileSync(monitor.store.file, 'utf8')
        .split('\n')
        .map(parseHealthLine)
        .filter((r): r is HealthRecord => r !== null);
    } catch {
      return [];
    }
  }

  async function playRow() {
    const [row] = await db.select().from(moviePlays).where(eq(moviePlays.id, started.play_id));
    return row!;
  }

  beforeAll(async () => {
    db = openTestDb();
    await truncateMovies(db);
    dir = await mkdtemp(path.join(os.tmpdir(), 'notesd-vlc-health-'));
    launchLog = path.join(dir, 'launches.jsonl');
    const basePort = await freePortBlock(10);
    const vlcBin = path.join(dir, 'vlc.exe');
    await writeFile(
      vlcBin,
      `#!/bin/sh\nexport FAKE_VLC_LOG='${launchLog}' FAKE_VLC_SPEED='1' FAKE_VLC_LIFE_MS='120000'\nexec "${process.execPath}" "${FAKE_VLC}" "$@"\n`,
    );
    await chmod(vlcBin, 0o755);
    const film = path.join(dir, 'Health.Film.2026.mkv');
    await writeFile(film, 'x');
    await seedTitle(db, { id: 'movie-990001', kind: 'movie', tmdbId: 990001, title: 'Health Film' });
    fileId = await seedFile(db, { titleId: 'movie-990001', host: HOST, path: film, durationS: 7200 });
    const config: MoviesConfig = {
      ...DEFAULT_MOVIES_CONFIG,
      enabled: true,
      vlc: { ...DEFAULT_MOVIES_CONFIG.vlc, bin: vlcBin, curlExe: CURL, httpPort: basePort, pollMs: 200, healthMs: 60_000, extraArgs: EXTRA },
    };
    monitor = new HealthMonitor({
      host: HOST,
      logDir: path.join(dir, 'movies'),
      intervalMs: 60_000,
      detect: async () => ({ available: true, env: { tasklist: '/fake/tasklist.exe', powershell: '/fake/powershell.exe' } }),
      tracked: () => player.healthView(),
      makeLister: () => launchLogLister(launchLog),
      makeEvents: () => null,
      log: () => {},
    });
    const service = {
      repo: new MoviesRepo(db),
      host: HOST,
      tmdb: null,
      events: { changed: () => undefined },
      addSyncHook: () => undefined,
    } as unknown as PlaybackService;
    player = buildMoviePlayback(service, config, {
      probe: wslProbe(),
      wslpath: async (_bin, abs) => `C:\\fake\\${path.basename(abs)}`,
      health: monitor,
    });
    await monitor.start();
    app = new Hono();
    app.route('/', moviesPlayRoutes({ db, moviesPlayer: player, moviesHealth: monitor }));
  });

  afterAll(async () => {
    await player.close();
    await monitor.close();
    for (const l of await launches()) {
      if (alive(l.pid)) process.kill(l.pid, 'SIGKILL');
    }
    await truncateMovies(db);
    await closeTestDb(db);
    await rm(dir, { recursive: true, force: true });
  });

  it('R8.4: the VLC notesd starts carries NOTESD_VLC_EXTRA_ARGS right before the file', async () => {
    started = await player.play(fileId);
    expect(started.tracking).toBe(true);
    const all = await launches();
    expect(all).toHaveLength(1);
    launch = all[0]!;
    const fileAt = launch.argv.length - 1;
    expect(launch.argv[fileAt]).toBe('C:\\fake\\Health.Film.2026.mkv');
    expect(launch.argv.slice(fileAt - EXTRA.length, fileAt)).toEqual(EXTRA);
    port = Number(argOf(launch.argv, '--http-port'));
  });

  it('R8.1: a sample of the notesd-started VLC carries its play, its paused state and seconds paused', async () => {
    const pw = argOf(launch.argv, '--http-password');
    await execFileAsync(CURL, ['-s', '-m', '2', '-u', `:${pw}`, `http://127.0.0.1:${port}/requests/status.json?command=pl_pause`]);
    await vi.waitFor(() => expect(player.current()?.state).toBe('paused'), { timeout: 5000, interval: 50 });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await monitor.sampleNow()).toBe(1);
    const sample = records().filter((r): r is SampleRecord => r.kind === 'sample').at(-1)!;
    expect(sample).toMatchObject({ pid: launch.pid, ours: true, play: { play_id: started.play_id, file_id: fileId, state: 'paused', hung: false } });
    expect(sample.play!.paused_s).toBeGreaterThanOrEqual(1);
    expect(sample.cmd).toContain('--http-password ***');
    expect(readFileSync(monitor.store.file, 'utf8')).not.toContain(pw);
    position = player.current()!.position;
  });

  it('R8.3: a VLC that stops answering while its process lives gets a hang line, and its play stays open at the last position', async () => {
    await fetch(`http://127.0.0.1:${port}/fake/hang?ms=7000`);
    await vi.waitFor(() => expect(records().some((r) => r.kind === 'hang' && r.phase === 'start')).toBe(true), { timeout: 15_000, interval: 200 });
    const hangStart = records().find((r): r is HangRecord => r.kind === 'hang' && r.phase === 'start')!;
    expect(hangStart).toMatchObject({ pid: launch.pid, port, play_id: started.play_id, file_id: fileId, outcome: null });
    expect(hangStart.position_s).toBeCloseTo(position, 0);
    const row = await playRow();
    expect(row.endedAt).toBeNull();
    expect(row.positionS).toBeCloseTo(position, 0);
    expect(player.healthView()?.hung).toBe(true);

    await vi.waitFor(() => expect(records().some((r) => r.kind === 'hang' && r.phase === 'end' && r.outcome === 'answered')).toBe(true), {
      timeout: 20_000,
      interval: 250,
    });
    expect(player.current()?.play_id).toBe(started.play_id);
  }, 45_000);

  it('R8.3: when that VLC exits, the play closes at the position it had before the hang', async () => {
    await fetch(`http://127.0.0.1:${port}/fake/quit`);
    await vi.waitFor(async () => expect((await playRow()).endedAt).not.toBeNull(), { timeout: 15_000, interval: 200 });
    expect((await playRow()).positionS).toBeCloseTo(position, 0);
    expect(player.current()).toBeNull();
  }, 30_000);

  it('R8.5: GET /api/movies/player/health returns the samples, the hang, the run summary; 400 on a bad limit; 503 with movies off', async () => {
    const res = await app.request('/api/movies/player/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthReport;
    expect(body).toMatchObject({ host: HOST, sampling: true, reason: null, interval_ms: 60_000, process_detail: true, incidents: [] });
    expect(body.samples.map((s) => s.pid)).toEqual([launch.pid]);
    expect(body.hangs.map((h) => [h.phase, h.outcome])).toEqual([
      ['start', null],
      ['end', 'answered'],
    ]);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({ pid: launch.pid, ours: true, samples: 1 });
    expect(body.last_start?.kind).toBe('start');
    expect((await app.request('/api/movies/player/health?limit=0')).status).toBe(400);
    expect((await app.request('/api/movies/player/health?limit=2001')).status).toBe(400);
    const off = new Hono();
    off.route('/', moviesPlayRoutes({ db, moviesPlayer: null, moviesHealth: null }));
    const offRes = await off.request('/api/movies/player/health');
    expect(offRes.status).toBe(503);
    expect(await offRes.json()).toMatchObject({ error: 'movies_off' });
  });
});
