import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const INSTALL = path.join(REPO, 'scripts', 'install.sh');

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server === null ? resolve() : server.close(() => resolve())));
  server = null;
});

/** A daemon whose GET /api/movies/player answers each of `answers` in turn (the last one for good); null: no JSON. */
async function daemon(answers: (object | null)[]): Promise<string> {
  let asked = 0;
  server = createServer((_req, res) => {
    const answer = answers[Math.min(asked++, answers.length - 1)];
    res.setHeader('content-type', answer === null ? 'text/plain' : 'application/json');
    res.end(answer === null ? 'not json' : JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/movies/player`;
}

/** Runs install.sh's guard_idle alone (the script is sourced: nothing is built or restarted). */
function guard(playerUrl: string, script = 'guard_idle', env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      ['-c', `source "$1"; NODE_BIN="$2"; PLAYER_URL="$3"; WAIT_IDLE_EVERY=1; ${script}; echo guard-passed`, '_', INSTALL, process.execPath, playerUrl],
      { env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ code: err === null ? 0 : typeof err.code === 'number' ? err.code : 1, stdout, stderr }),
    );
  });
}

const IDLE = { available: true, reason: null, current: null, stream: null, starting: [], busy: false };
const STARTING = {
  ...IDLE,
  busy: true,
  starting: [{ kind: 'movie', tmdb_id: 818647, season: null, episode: null, title: 'Through My Window', provider: 'torrent', since: '2026-11-16T20:46:14.000Z', stage: 'opening 3 torrents' }],
};

describe('install.sh: never restart under a play', () => {
  it('passes when nothing plays or starts, when no daemon answers, and when the answer is not JSON', async () => {
    expect((await guard(await daemon([IDLE]))).stdout).toContain('guard-passed');
    expect((await guard('http://127.0.0.1:1/api/movies/player')).stdout).toContain('guard-passed');
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    expect((await guard(await daemon([null]))).stdout).toContain('guard-passed');
  });

  it('exits 75 and names the play while one is still being started, although no stream reports yet', async () => {
    const out = await guard(await daemon([STARTING]));
    expect(out.code).toBe(75);
    expect(out.stdout).not.toContain('guard-passed');
    expect(out.stderr).toContain('a play of Through My Window is being started since 2026-11-16T20:46:14.000Z: opening 3 torrents');
    expect(out.stderr).toContain('Nothing was changed');
  });

  it('exits 75 for a stream on screen and for a VLC play', async () => {
    const stream = await guard(await daemon([{ ...IDLE, busy: true, stream: { session_id: 's', title_id: 'movie-550', provider: 'Torrent', state: 'paused' } }]));
    expect(stream.code).toBe(75);
    expect(stream.stderr).toContain('a stream is on screen from Torrent (paused, movie-550)');
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const vlc = await guard(await daemon([{ ...IDLE, busy: true, current: { name: 'Film.mkv', state: 'playing' } }]));
    expect(vlc.code).toBe(75);
    expect(vlc.stderr).toContain('VLC is open on Film.mkv (playing)');
  });

  it('--force restarts anyway and says what it interrupts', async () => {
    const out = await guard(await daemon([STARTING]), 'FORCE=1; guard_idle');
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('guard-passed');
    expect(out.stderr).toContain('restarting although the daemon is busy');
  });

  it('--wait goes on once the daemon is idle, and gives up with 75 when it stays busy', async () => {
    const idleLater = await guard(await daemon([STARTING, STARTING, IDLE]), 'WAIT_IDLE=1; guard_idle');
    expect(idleLater.code).toBe(0);
    expect(idleLater.stdout).toContain('notesd is idle after');
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const never = await guard(await daemon([STARTING]), 'WAIT_IDLE=1; WAIT_IDLE_SECONDS=2; guard_idle');
    expect(never.code).toBe(75);
    expect(never.stderr).toContain('still busy after 2s');
  });

  it('--check-idle asks and changes nothing: 0 when idle, 75 when busy, whatever --force says', async () => {
    const idle = await guard(await daemon([IDLE]), 'check_idle');
    expect(idle.code).toBe(0);
    expect(idle.stdout).toContain('nothing is playing or being started');
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    expect((await guard(await daemon([STARTING]), 'FORCE=1; check_idle')).code).toBe(75);
  });

  it('NOTES_INSTALL_FORCE=1 is --force', async () => {
    expect((await guard(await daemon([STARTING]), 'guard_idle', { NOTES_INSTALL_FORCE: '1' })).code).toBe(0);
  });
});
