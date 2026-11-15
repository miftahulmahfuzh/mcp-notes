import { describe, expect, it, vi } from 'vitest';
import { MoviePlayer, type MoviePlayerDeps, type PlayerRepo } from '../../../src/movies/player.js';
import { statusUrl, type VlcEndpoint } from '../../../src/movies/vlc/http.js';
import type { PidCheck, PlayerHealthLink } from '../../../src/movies/vlc/health.js';
import type { PlayerDetection } from '../../../src/movies/vlc/launch.js';
import { MemVlc } from '../../fixtures/movies/memVlc.js';
import { fileRow, playRow, type FileRow, type PlayRow } from '../../fixtures/movies/rows.js';

const PORT = 47318;
const ENV_OK: PlayerDetection = { available: true, env: { vlc: '/vlc.exe', curl: '/curl.exe', wslpath: '/usr/bin/wslpath' } };

class MemRepo {
  files = new Map<number, FileRow>();
  plays: PlayRow[] = [];
  async fileById(id: number): Promise<FileRow | null> {
    return this.files.get(id) ?? null;
  }
  async lastPlay(fileId: number): Promise<PlayRow | null> {
    return [...this.plays].filter((p) => p.fileId === fileId).at(-1) ?? null;
  }
  async startPlay(i: { fileId: number; host: string; source: 'live'; startPositionS: number; durationS: number | null }): Promise<PlayRow> {
    const now = new Date();
    const row = playRow({ id: this.plays.length + 1, fileId: i.fileId, host: i.host, source: i.source, startedAt: now, endedAt: null, startPositionS: i.startPositionS, positionS: i.startPositionS, durationS: i.durationS, updatedAt: now });
    this.plays.push(row);
    return row;
  }
  async updatePlay(id: number, i: { positionS: number | null; durationS: number | null }): Promise<boolean> {
    Object.assign(this.plays.find((p) => p.id === id)!, { positionS: i.positionS, durationS: i.durationS });
    return true;
  }
  async endPlay(id: number, i: { positionS?: number | null; durationS?: number | null }, endedAt: Date = new Date()): Promise<PlayRow | null> {
    const p = this.plays.find((x) => x.id === id)!;
    Object.assign(p, { positionS: i.positionS ?? null, durationS: i.durationS ?? null, endedAt });
    return p;
  }
  async closeOpenPlays(): Promise<number> {
    return 0;
  }
}

class Health implements PlayerHealthLink {
  check: PidCheck = { kind: 'alive', pid: 1 };
  async processAlive(): Promise<PidCheck> {
    return this.check;
  }
  onHang(): void {}
  onVideoStall(): void {}
}

function setup(over: Partial<MoviePlayerDeps> = {}) {
  const repo = new MemRepo();
  const vlc = new MemVlc();
  const raised: VlcEndpoint[] = [];
  repo.files.set(1, fileRow({ id: 1, path: '/lib/A.mkv', name: 'A.mkv', durationS: 7200 }));
  repo.files.set(2, fileRow({ id: 2, path: '/lib/B.mkv', name: 'B.mkv', durationS: 7200 }));
  const player = new MoviePlayer({
    repo: repo as unknown as PlayerRepo,
    host: 'this-host',
    httpPort: PORT,
    pollMs: 5,
    detect: async () => ENV_OK,
    launcher: vlc,
    reader: vlc,
    wslpath: async (_bin, abs) => `C:${abs.replaceAll('/', '\\')}`,
    exists: async () => true,
    readyTimeoutMs: 100,
    readyIntervalMs: 5,
    playingTimeoutMs: 50,
    health: new Health(),
    foreground: async (ep) => {
      raised.push(ep);
      return { kind: 'ok', pid: 1, foreground: true };
    },
    log: () => {},
    ...over,
  });
  return { repo, vlc, player, raised };
}

describe('playing the file that is already open (rejoin)', () => {
  it('starts no second VLC: the paused one is told to play, comes to the front and keeps its play row', async () => {
    const s = setup();
    const first = await s.player.play(1);
    s.vlc.at(PORT).time = 1196;
    s.vlc.at(PORT).state = 'paused';
    await vi.waitFor(() => expect(s.player.current()).toMatchObject({ state: 'paused', position: 1196 }));
    s.raised.length = 0;

    const again = await s.player.play(1);
    expect(again).toEqual({ ...first, start_position: 1196, already_playing: true });
    expect(s.vlc.launches).toHaveLength(1);
    expect(s.repo.plays).toHaveLength(1);
    expect(s.repo.plays[0]!.endedAt).toBeNull();
    expect(s.vlc.commands.at(-1)).toEqual({ command: 'pl_forceresume' });
    expect(s.vlc.at(PORT).state).toBe('playing');
    expect(s.player.current()).toMatchObject({ play_id: first.play_id, state: 'playing' });
    expect(s.player.healthView()!.pausedSince).toBeNull();
    expect(s.raised).toEqual([{ port: PORT, password: s.vlc.launches[0]!.password }]);
    expect(statusUrl({ port: PORT, password: 'x' }, { command: 'pl_forceresume' })).toBe(`http://127.0.0.1:${PORT}/requests/status.json?command=pl_forceresume`);
    await s.player.close();
  });

  it('a playing one is only brought to the front, with no command sent', async () => {
    const s = setup();
    await s.player.play(1);
    const sent = s.vlc.commands.length;
    expect((await s.player.play(1)).already_playing).toBe(true);
    expect(s.vlc.commands).toHaveLength(sent);
    expect(s.vlc.launches).toHaveLength(1);
    await s.player.close();
  });

  it('starts a new VLC as before for another file, and when the open one is stopped, gone or without video', async () => {
    const other = setup();
    await other.player.play(1);
    const b = await other.player.play(2);
    expect(b.already_playing).toBeUndefined();
    expect(other.vlc.launches).toHaveLength(2);
    expect(other.repo.plays[0]!.endedAt).not.toBeNull();
    await other.player.close();

    const stopped = setup();
    await stopped.player.play(1);
    stopped.vlc.at(PORT).state = 'stopped';
    expect((await stopped.player.play(1)).already_playing).toBeUndefined();
    expect(stopped.vlc.launches).toHaveLength(2);
    await stopped.player.close();

    const gone = setup({ health: undefined as never });
    await gone.player.play(1);
    gone.vlc.exit(PORT);
    expect((await gone.player.play(1)).already_playing).toBeUndefined();
    expect(gone.vlc.launches).toHaveLength(2);
    await gone.player.close();

    const stalled = setup();
    await stalled.player.play(1);
    const i = stalled.vlc.at(PORT);
    i.video = { decoded: 10, displayed: 10 };
    const tick = setInterval(() => {
      i.time += 5;
      if (i.time < 20) i.video = { decoded: i.video!.decoded + 1, displayed: i.video!.displayed + 1 };
    }, 5);
    await vi.waitFor(() => expect(stalled.player.current()?.video_stalled).toBe(true));
    clearInterval(tick);
    expect((await stalled.player.play(1)).already_playing).toBeUndefined();
    expect(stalled.vlc.launches).toHaveLength(2);
    await stalled.player.close();
  });
});
