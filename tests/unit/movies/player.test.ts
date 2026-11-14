import { describe, expect, it, vi } from 'vitest';
import { MoviePlayer, PlayError, type MoviePlayerDeps, type PlayerRepo } from '../../../src/movies/player.js';
import type { PlayerDetection } from '../../../src/movies/vlc/launch.js';
import { MemVlc } from '../../fixtures/movies/memVlc.js';
import { fileRow, playRow, T0, type FileRow, type PlayRow } from '../../fixtures/movies/rows.js';

const ENV_OK: PlayerDetection = { available: true, env: { vlc: '/vlc.exe', curl: '/curl.exe', wslpath: '/usr/bin/wslpath' } };
const PORT = 47318;

class MemRepo {
  files = new Map<number, FileRow>();
  plays: PlayRow[] = [];
  async fileById(id: number): Promise<FileRow | null> {
    return this.files.get(id) ?? null;
  }
  async lastPlay(fileId: number): Promise<PlayRow | null> {
    return [...this.plays].filter((p) => p.fileId === fileId).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || b.id - a.id)[0] ?? null;
  }
  async startPlay(i: { fileId: number; host: string; source: 'live'; startPositionS: number; durationS: number | null }): Promise<PlayRow> {
    const now = new Date();
    const row = playRow({ id: this.plays.length + 1, fileId: i.fileId, host: i.host, source: i.source, startedAt: now, endedAt: null, startPositionS: i.startPositionS, positionS: i.startPositionS, durationS: i.durationS, updatedAt: now });
    this.plays.push(row);
    return row;
  }
  async updatePlay(id: number, i: { positionS: number | null; durationS: number | null }): Promise<boolean> {
    Object.assign(this.play(id), { positionS: i.positionS, durationS: i.durationS, updatedAt: new Date() });
    return true;
  }
  async endPlay(id: number, i: { positionS?: number | null; durationS?: number | null }, endedAt: Date = new Date()): Promise<PlayRow | null> {
    Object.assign(this.play(id), { positionS: i.positionS ?? null, durationS: i.durationS ?? null, endedAt });
    return this.play(id);
  }
  async closeOpenPlays(host: string): Promise<number> {
    const open = this.plays.filter((p) => p.host === host && p.source === 'live' && p.endedAt === null);
    for (const p of open) p.endedAt = p.updatedAt;
    return open.length;
  }
  play(id: number): PlayRow {
    const p = this.plays.find((x) => x.id === id);
    if (p === undefined) throw new Error(`no play ${id}`);
    return p;
  }
}

function setup(over: Partial<MoviePlayerDeps> = {}) {
  const repo = new MemRepo();
  const vlc = new MemVlc();
  repo.files.set(1, fileRow({ id: 1, path: '/lib/A.mkv', name: 'A.mkv', durationS: 7200 }));
  repo.files.set(2, fileRow({ id: 2, path: '/lib/B.mkv', name: 'B.mkv', durationS: 7200 }));
  const player = new MoviePlayer({
    repo: repo as unknown as PlayerRepo,
    host: 'this-host',
    httpPort: PORT,
    pollMs: 10,
    detect: async () => ENV_OK,
    launcher: vlc,
    reader: vlc,
    wslpath: async (_bin, abs) => `C:${abs.replaceAll('/', '\\')}`,
    exists: async (abs) => !abs.includes('gone'),
    readyTimeoutMs: 100,
    readyIntervalMs: 5,
    playingTimeoutMs: 50,
    log: () => {},
    ...over,
  });
  return { repo, vlc, player };
}

describe('MoviePlayer.play', () => {
  it('launches at the resume position, presses play and seeks there (R4.1)', async () => {
    const { repo, vlc, player } = setup();
    repo.plays.push(playRow({ id: 99, fileId: 1, startedAt: T0, positionS: 1200, durationS: 7200 }));
    const started = await player.play(1);
    expect(started).toMatchObject({ file_id: 1, start_position: 1200, port: PORT, tracking: true, note: null });
    expect(vlc.launches[0]).toMatchObject({ winPath: 'C:\\lib\\A.mkv', port: PORT, startTime: 1200 });
    expect(vlc.at(PORT)).toMatchObject({ state: 'playing', time: 1200, length: 7200 });
    expect(repo.play(started.play_id)).toMatchObject({ startPositionS: 1200, endedAt: null });
    await player.close();
  });

  it('starts a finished file from 0 without seeking', async () => {
    const { repo, vlc, player } = setup();
    repo.plays.push(playRow({ id: 99, fileId: 1, startedAt: T0, positionS: 7000, durationS: 7200 }));
    const started = await player.play(1);
    expect(started.start_position).toBe(0);
    expect(vlc.at(PORT).time).toBe(0);
    await player.close();
  });

  it('records each poll and ends with the last position when VLC exits (R4.2, R4.3)', async () => {
    const { repo, vlc, player } = setup();
    const started = await player.play(1);
    vlc.at(PORT).time = 1300;
    await vi.waitFor(() => expect(repo.play(started.play_id).positionS).toBe(1300));
    expect(player.current()).toMatchObject({ play_id: started.play_id, position: 1300, duration: 7200, state: 'playing' });
    vlc.at(PORT).state = 'stopped';
    vlc.at(PORT).time = 0;
    await new Promise((r) => setTimeout(r, 40));
    expect(repo.play(started.play_id).positionS).toBe(1300); // stopped reads are not recorded
    vlc.exit(PORT);
    await vi.waitFor(() => expect(repo.play(started.play_id).endedAt).not.toBeNull());
    expect(repo.play(started.play_id).positionS).toBe(1300);
    expect(player.current()).toBeNull();
  });

  it('a second play ends the first, leaves its VLC running and takes the next port', async () => {
    const { repo, vlc, player } = setup();
    const a = await player.play(1);
    const b = await player.play(2);
    expect(repo.play(a.play_id).endedAt).not.toBeNull();
    expect(vlc.instances.has(PORT)).toBe(true);
    expect(b.port).toBe(PORT + 1);
    expect(player.current()?.play_id).toBe(b.play_id);
    await player.close();
  });

  it('skips a port another VLC holds, and fails with no_free_port when all ten are held', async () => {
    const { vlc, player } = setup();
    vlc.occupy(PORT, 'theirs');
    expect((await player.play(1)).port).toBe(PORT + 1);
    await player.close();
    const second = setup();
    for (let i = 0; i < 10; i++) second.vlc.occupy(PORT + i, 'theirs');
    await expect(second.player.play(1)).rejects.toMatchObject({ code: 'player_unavailable', reason: 'no_free_port' });
  });

  it('closes the play untracked at the start position when HTTP never answers', async () => {
    const { repo, vlc, player } = setup();
    vlc.httpUp = false;
    repo.plays.push(playRow({ id: 99, fileId: 1, startedAt: T0, positionS: 600, durationS: 7200 }));
    const started = await player.play(1);
    expect(started).toMatchObject({ tracking: false, note: 'http_timeout', start_position: 600 });
    expect(repo.play(started.play_id)).toMatchObject({ positionS: 600 });
    expect(repo.play(started.play_id).endedAt).not.toBeNull();
    expect(player.current()).toBeNull();
  });

  it('refuses other hosts, deleted or vanished files, unknown ids and a missing player', async () => {
    const { repo, vlc, player } = setup();
    repo.files.set(3, fileRow({ id: 3, host: 'other-laptop' }));
    repo.files.set(4, fileRow({ id: 4, deletedAt: T0 }));
    repo.files.set(5, fileRow({ id: 5, path: '/lib/gone.mkv' }));
    await expect(player.play(3)).rejects.toMatchObject({ code: 'not_on_this_machine', host: 'other-laptop' });
    await expect(player.play(4)).rejects.toMatchObject({ code: 'file_missing' });
    await expect(player.play(5)).rejects.toMatchObject({ code: 'file_missing' });
    await expect(player.play(404)).rejects.toBeInstanceOf(PlayError);
    expect(vlc.launches).toEqual([]);
    const off = setup({ detect: async () => ({ available: false, reason: 'no_curl' }) });
    await expect(off.player.play(1)).rejects.toMatchObject({ code: 'player_unavailable', reason: 'no_curl' });
    expect(await off.player.availability()).toEqual({ available: false, reason: 'no_curl' });
  });

  it('a failed launch writes no play row', async () => {
    const { repo, vlc, player } = setup();
    vlc.failLaunch = true;
    await expect(player.play(1)).rejects.toMatchObject({ code: 'player_unavailable', reason: 'launch_failed' });
    expect(repo.plays).toEqual([]);
  });
});

describe('MoviePlayer.close and start', () => {
  it('close ends the tracked play at its last position and leaves VLC running', async () => {
    const { repo, vlc, player } = setup();
    const started = await player.play(1);
    vlc.at(PORT).time = 2500;
    await vi.waitFor(() => expect(repo.play(started.play_id).positionS).toBe(2500));
    await player.close();
    expect(repo.play(started.play_id)).toMatchObject({ positionS: 2500 });
    expect(repo.play(started.play_id).endedAt).not.toBeNull();
    expect(vlc.instances.has(PORT)).toBe(true);
  });

  it('start closes plays a previous process left open', async () => {
    const { repo, player } = setup();
    repo.plays.push(playRow({ id: 7, fileId: 1, endedAt: null, positionS: 500, updatedAt: T0 }));
    expect(await player.start()).toBe(1);
    expect(repo.play(7)).toMatchObject({ endedAt: T0, positionS: 500 });
  });
});
