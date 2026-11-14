import { describe, expect, it, vi } from 'vitest';
import { HANG_AFTER_SILENT_POLLS, MAX_READ_ERRORS, MoviePlayer, type MoviePlayerDeps, type PlayerRepo } from '../../../src/movies/player.js';
import type { VlcEndpoint, VlcReply } from '../../../src/movies/vlc/http.js';
import type { HangEvent, PidCheck, PlayerHealthLink } from '../../../src/movies/vlc/health.js';
import type { PlayerDetection } from '../../../src/movies/vlc/launch.js';
import { MemVlc } from '../../fixtures/movies/memVlc.js';
import { fileRow, playRow, type FileRow, type PlayRow } from '../../fixtures/movies/rows.js';

const ENV_OK: PlayerDetection = { available: true, env: { vlc: '/vlc.exe', curl: '/curl.exe', wslpath: '/usr/bin/wslpath' } };
const PORT = 47318;

/** A VLC that stops answering on some ports (curl.exe -m 2 exits 28). */
class SilentVlc extends MemVlc {
  readonly silent = new Set<number>();
  /** Ports that miss exactly one status read. */
  readonly silentOnce = new Set<number>();
  override async status(curl: string, ep: VlcEndpoint): Promise<VlcReply> {
    if (this.silentOnce.delete(ep.port)) return { kind: 'error', message: 'curl exited 28' };
    if (this.silent.has(ep.port)) return { kind: 'error', message: 'curl exited 28' };
    return super.status(curl, ep);
  }
}

class FakeHealth implements PlayerHealthLink {
  check: PidCheck = { kind: 'alive', pid: 4242 };
  checks = 0;
  readonly events: HangEvent[] = [];
  async processAlive(): Promise<PidCheck> {
    this.checks += 1;
    return this.check;
  }
  onHang(e: HangEvent): void {
    this.events.push(e);
  }
}

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
  async closeOpenPlays(): Promise<number> {
    return 0;
  }
  play(id: number): PlayRow {
    const p = this.plays.find((x) => x.id === id);
    if (p === undefined) throw new Error(`no play ${id}`);
    return p;
  }
}

function setup(over: Partial<MoviePlayerDeps> = {}) {
  const repo = new MemRepo();
  const vlc = new SilentVlc();
  const health = new FakeHealth();
  repo.files.set(1, fileRow({ id: 1, path: '/lib/A.mkv', name: 'A.mkv', durationS: 7200 }));
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
    health,
    log: () => {},
    ...over,
  });
  return { repo, vlc, health, player };
}

async function playingAt1300(s: ReturnType<typeof setup>): Promise<number> {
  const started = await s.player.play(1);
  s.vlc.at(PORT).time = 1300;
  await vi.waitFor(() => expect(s.repo.play(started.play_id).positionS).toBe(1300));
  return started.play_id;
}

describe('the hang rule (R8.3)', () => {
  it('R8.3: a VLC silent with its process alive gets one hang line and keeps its play open at the last position past MAX_READ_ERRORS', async () => {
    const s = setup();
    const playId = await playingAt1300(s);
    s.vlc.silent.add(PORT);
    await vi.waitFor(() => expect(s.health.checks).toBeGreaterThanOrEqual(MAX_READ_ERRORS + 3));
    expect(s.health.events).toHaveLength(1);
    expect(s.health.events[0]).toMatchObject({ phase: 'start', pid: 4242, port: PORT, playId, positionS: 1300 });
    expect(s.repo.play(playId)).toMatchObject({ endedAt: null, positionS: 1300 });
    expect(s.player.current()?.play_id).toBe(playId);
    expect(s.player.healthView()).toMatchObject({ hung: true, positionS: 1300 });
    expect(s.player.healthView()!.silentSince).toBeInstanceOf(Date);

    s.vlc.silent.delete(PORT);
    await vi.waitFor(() => expect(s.health.events.at(-1)).toMatchObject({ phase: 'end', outcome: 'answered' }));
    expect(s.player.healthView()).toMatchObject({ hung: false, silentSince: null });
    s.vlc.at(PORT).time = 1400;
    await vi.waitFor(() => expect(s.repo.play(playId).positionS).toBe(1400));
    await s.player.close();
  });

  it('R8.3: silent and then gone ends the play exited at the position read before the silence', async () => {
    const s = setup();
    const playId = await playingAt1300(s);
    s.vlc.silent.add(PORT);
    await vi.waitFor(() => expect(s.health.events).toHaveLength(1));
    s.health.check = { kind: 'gone' };
    await vi.waitFor(() => expect(s.repo.play(playId).endedAt).not.toBeNull());
    expect(s.repo.play(playId).positionS).toBe(1300);
    expect(s.health.events.at(-1)).toMatchObject({ phase: 'end', outcome: 'exited' });
    expect(s.player.current()).toBeNull();
  });

  it('R8.3: connection refused while the process still exists is a hang, not an exit', async () => {
    const s = setup();
    const playId = await playingAt1300(s);
    s.vlc.at(PORT).up = false;
    await vi.waitFor(() => expect(s.health.events).toHaveLength(1));
    expect(s.health.events[0]!.phase).toBe('start');
    expect(s.repo.play(playId).endedAt).toBeNull();
    s.health.check = { kind: 'gone' };
    await vi.waitFor(() => expect(s.repo.play(playId).endedAt).not.toBeNull());
    expect(s.repo.play(playId).positionS).toBe(1300);
  });

  it('does not call a single silent poll a hang', async () => {
    const s = setup();
    const playId = await playingAt1300(s);
    s.vlc.silentOnce.add(PORT);
    await vi.waitFor(() => expect(s.vlc.silentOnce.size).toBe(0));
    s.vlc.at(PORT).time = 1350;
    await vi.waitFor(() => expect(s.repo.play(playId).positionS).toBe(1350));
    expect(HANG_AFTER_SILENT_POLLS).toBe(2);
    expect(s.health.checks).toBe(0);
    expect(s.health.events).toEqual([]);
    await s.player.close();
  });

  it('with the process unknown, keeps Phase 5 rules: a refused poll ends at once, curl errors end after MAX_READ_ERRORS', async () => {
    const a = setup();
    a.health.check = { kind: 'unknown', reason: 'no_process_detail' };
    const pa = await playingAt1300(a);
    a.vlc.at(PORT).up = false;
    await vi.waitFor(() => expect(a.repo.play(pa).endedAt).not.toBeNull());
    expect(a.health.events).toEqual([]);

    const b = setup();
    b.health.check = { kind: 'unknown', reason: 'no_process_detail' };
    const pb = await playingAt1300(b);
    b.vlc.silent.add(PORT);
    await vi.waitFor(() => expect(b.repo.play(pb).endedAt).not.toBeNull());
    expect(b.repo.play(pb).positionS).toBe(1300);
    expect(b.health.events).toEqual([]);
  });

  it('a hang that is still open when tracking ends is closed as tracking_ended', async () => {
    const s = setup();
    await playingAt1300(s);
    s.vlc.silent.add(PORT);
    await vi.waitFor(() => expect(s.health.events).toHaveLength(1));
    await s.player.close();
    expect(s.health.events.at(-1)).toMatchObject({ phase: 'end', outcome: 'tracking_ended' });
  });
});

describe('the paused clock (R8.1)', () => {
  it('R8.1: stamps the first paused poll and clears it when VLC plays again', async () => {
    let clock = new Date('2026-11-14T06:00:00.000Z');
    const s = setup({ now: () => clock });
    await playingAt1300(s);
    expect(s.player.healthView()!.pausedSince).toBeNull();
    s.vlc.at(PORT).state = 'paused';
    await vi.waitFor(() => expect(s.player.healthView()!.state).toBe('paused'));
    const since = s.player.healthView()!.pausedSince;
    expect(since?.toISOString()).toBe('2026-11-14T06:00:00.000Z');
    clock = new Date('2026-11-14T06:10:00.000Z');
    await new Promise((r) => setTimeout(r, 30));
    expect(s.player.healthView()!.pausedSince).toEqual(since);
    s.vlc.at(PORT).state = 'playing';
    await vi.waitFor(() => expect(s.player.healthView()!.pausedSince).toBeNull());
    await s.player.close();
  });
});
