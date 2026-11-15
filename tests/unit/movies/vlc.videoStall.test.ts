import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoviePlayer, STALL_AFTER_FROZEN_POLLS, type MoviePlayerDeps, type PlayerRepo } from '../../../src/movies/player.js';
import { HealthLog, HealthMonitor, type HealthRecord, type PidCheck, type PlayerHealthLink, type ProcessListing, type VideoStallEvent, type WinGpuEvent } from '../../../src/movies/vlc/health.js';
import { parseStatusJson } from '../../../src/movies/vlc/http.js';
import { gpuEventsScript, parseGpuEvents, type GpuEventsResult } from '../../../src/movies/vlc/incidents.js';
import type { PlayerDetection } from '../../../src/movies/vlc/launch.js';
import { MemVlc } from '../../fixtures/movies/memVlc.js';
import { fileRow, playRow, type FileRow, type PlayRow } from '../../fixtures/movies/rows.js';

const PORT = 47318;
const ENV_OK: PlayerDetection = { available: true, env: { vlc: '/vlc.exe', curl: '/curl.exe', wslpath: '/usr/bin/wslpath' } };
const RESET_MESSAGE = 'Display driver igfxn stopped responding and has successfully recovered.';

describe('reading the video counters and the display-driver events', () => {
  it('takes decodedvideo and displayedpictures from status.json stats, and leaves video out without them', () => {
    const base = { state: 'playing', time: 1287, length: 6328 };
    expect(parseStatusJson(JSON.stringify({ ...base, stats: { decodedvideo: 60194, displayedpictures: 30010, lostpictures: 1 } }))).toEqual({
      ...base,
      video: { decoded: 60194, displayed: 30010 },
    });
    expect(parseStatusJson(JSON.stringify(base))).toEqual(base);
    expect(parseStatusJson(JSON.stringify({ ...base, stats: { decodedvideo: 'x' } }))).toEqual(base);
  });

  it('MEASURED 2026-11-15: parses the 4101 driver-reset event, oldest first, and asks the System log for provider Display in local time', () => {
    const one = { time: '2026-11-15T00:09:22.0000000Z', id: 4101, provider: 'Display', message: `${RESET_MESSAGE}\r\n` };
    const two = { ...one, time: '2026-11-14T06:03:46.0000000Z' };
    expect(parseGpuEvents(`noise\n${JSON.stringify([one, two])}\n`)).toEqual([
      { time: two.time, event_id: 4101, provider: 'Display', message: RESET_MESSAGE },
      { time: one.time, event_id: 4101, provider: 'Display', message: RESET_MESSAGE },
    ]);
    expect(parseGpuEvents(JSON.stringify(one))).toHaveLength(1);
    expect(parseGpuEvents('[]')).toEqual([]);
    expect(parseGpuEvents('nope')).toBeNull();
    const script = gpuEventsScript(new Date('2026-11-15T00:00:00.000Z'), new Date('2026-11-15T00:10:00.000Z'));
    expect(script).toContain("LogName = 'System'; ProviderName = 'Display'");
    expect(script).toContain("[DateTimeOffset]::Parse('2026-11-15T00:00:00.000Z').LocalDateTime");
  });
});

class MemRepo {
  files = new Map<number, FileRow>();
  plays: PlayRow[] = [];
  async fileById(id: number): Promise<FileRow | null> {
    return this.files.get(id) ?? null;
  }
  async lastPlay(): Promise<PlayRow | null> {
    return null;
  }
  async startPlay(i: { fileId: number; host: string; source: 'live'; startPositionS: number; durationS: number | null }): Promise<PlayRow> {
    const now = new Date();
    const row = playRow({ id: this.plays.length + 1, fileId: i.fileId, host: i.host, source: i.source, startedAt: now, endedAt: null, startPositionS: i.startPositionS, positionS: i.startPositionS, durationS: i.durationS, updatedAt: now });
    this.plays.push(row);
    return row;
  }
  async updatePlay(id: number, i: { positionS: number | null; durationS: number | null }): Promise<boolean> {
    Object.assign(this.play(id), { positionS: i.positionS, durationS: i.durationS });
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

/** Every status read advances the clock by 5 s; the video counters advance only while `frames` is on. */
class TickingVlc extends MemVlc {
  frames = true;
  reads = 0;
  override async status(curl: string, ep: { port: number; password: string }) {
    const i = this.instances.get(ep.port);
    if (i !== undefined && i.state === 'playing' && i.video !== undefined) {
      this.reads += 1;
      i.time += 5;
      if (this.frames) i.video = { decoded: i.video.decoded + 120, displayed: i.video.displayed + 120 };
    }
    return super.status(curl, ep);
  }
}

class FakeHealth implements PlayerHealthLink {
  check: PidCheck = { kind: 'alive', pid: 17984 };
  readonly stalls: VideoStallEvent[] = [];
  async processAlive(): Promise<PidCheck> {
    return this.check;
  }
  onHang(): void {}
  onVideoStall(e: VideoStallEvent): void {
    this.stalls.push(e);
  }
}

function playerSetup(over: Partial<MoviePlayerDeps> = {}) {
  const repo = new MemRepo();
  const vlc = new TickingVlc();
  const health = new FakeHealth();
  const lines: string[] = [];
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
    log: (l) => lines.push(l),
    ...over,
  });
  return { repo, vlc, health, player, lines };
}

async function playingWithVideo(s: ReturnType<typeof playerSetup>): Promise<number> {
  const started = await s.player.play(1);
  s.vlc.at(PORT).video = { decoded: 100, displayed: 50 };
  await vi.waitFor(() => expect(s.vlc.reads).toBeGreaterThanOrEqual(3));
  return started.play_id;
}

describe('the video-stall rule', () => {
  it('MEASURED 2026-11-15: playing, clock advancing and both counters frozen is a stall after three polls; the play stays open and keeps its position', async () => {
    const s = playerSetup();
    const playId = await playingWithVideo(s);
    expect(s.player.current()!.video_stalled).toBe(false);
    s.vlc.frames = false;
    await vi.waitFor(() => expect(s.health.stalls).toHaveLength(1));
    expect(STALL_AFTER_FROZEN_POLLS).toBe(3);
    expect(s.health.stalls[0]).toMatchObject({ phase: 'start', pid: 17984, port: PORT, playId, fileId: 1, name: 'A.mkv' });
    expect(s.health.stalls[0]!.stalledSince).toBeInstanceOf(Date);
    expect(s.player.current()).toMatchObject({ play_id: playId, video_stalled: true });
    expect(s.player.healthView()).toMatchObject({ videoStalled: true });
    expect(s.repo.play(playId).endedAt).toBeNull();
    expect(s.lines.some((l) => l.includes('plays without video'))).toBe(true);

    const before = s.vlc.reads;
    await vi.waitFor(() => expect(s.vlc.reads).toBeGreaterThan(before + 4));
    expect(s.health.stalls).toHaveLength(1);
    expect(s.repo.play(playId).positionS).toBe(s.player.current()!.position);

    await s.player.close();
    expect(s.health.stalls.at(-1)).toMatchObject({ phase: 'end', outcome: 'tracking_ended' });
  });

  it('a stall outlives a pause, ends as recovered when frames come back, and as exited when VLC goes', async () => {
    const s = playerSetup();
    await playingWithVideo(s);
    s.vlc.frames = false;
    await vi.waitFor(() => expect(s.health.stalls).toHaveLength(1));
    s.vlc.at(PORT).state = 'paused';
    await vi.waitFor(() => expect(s.player.current()!.state).toBe('paused'));
    expect(s.player.current()!.video_stalled).toBe(true);
    s.vlc.at(PORT).state = 'playing';
    s.vlc.frames = true;
    await vi.waitFor(() => expect(s.health.stalls).toHaveLength(2));
    expect(s.health.stalls[1]).toMatchObject({ phase: 'end', outcome: 'recovered' });
    expect(s.player.current()!.video_stalled).toBe(false);

    s.vlc.frames = false;
    await vi.waitFor(() => expect(s.health.stalls).toHaveLength(3));
    s.health.check = { kind: 'gone' };
    s.vlc.exit(PORT);
    await vi.waitFor(() => expect(s.health.stalls).toHaveLength(4));
    expect(s.health.stalls[3]).toMatchObject({ phase: 'end', outcome: 'exited' });
  });

  it('never calls it a stall while paused, for a file whose counters never moved, or without stats', async () => {
    const paused = playerSetup();
    await playingWithVideo(paused);
    paused.vlc.at(PORT).state = 'paused';
    await new Promise((r) => setTimeout(r, 60));
    expect(paused.health.stalls).toEqual([]);
    await paused.player.close();

    const audio = playerSetup();
    await audio.player.play(1);
    audio.vlc.at(PORT).video = { decoded: 1, displayed: 1 };
    audio.vlc.frames = false;
    await vi.waitFor(() => expect(audio.vlc.reads).toBeGreaterThanOrEqual(8));
    expect(audio.health.stalls).toEqual([]);
    await audio.player.close();

    const noStats = playerSetup();
    const id = await noStats.player.play(1);
    noStats.vlc.at(PORT).time = 500;
    await vi.waitFor(() => expect(noStats.repo.play(id.play_id).positionS).toBe(500));
    expect(noStats.health.stalls).toEqual([]);
    await noStats.player.close();
  });
});

const HOST = 'this-host';
const PW = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OURS_CMD = `"C:\\vlc.exe" --extraintf http --http-port 47318 --http-password ${PW} C:\\Film.mkv`;
const T = new Date('2026-11-15T00:10:00.000Z');
const RESET: WinGpuEvent = { time: '2026-11-15T00:09:22.000Z', event_id: 4101, provider: 'Display', message: RESET_MESSAGE };

describe('HealthMonitor: driver resets and video stalls', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vlc-stall-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function setup(gpu: { result: GpuEventsResult; windows: Array<[string, string]> } | null) {
    const clock = { now: T };
    const lines: string[] = [];
    const listing: { value: ProcessListing } = {
      value: { kind: 'ok', detail: true, processes: [{ pid: 17984, wsBytes: 1, privateBytes: 1, handles: 1, startedAt: null, commandLine: OURS_CMD }] },
    };
    const m = new HealthMonitor({
      host: HOST,
      logDir: dir,
      intervalMs: 30_000,
      detect: async () => ({ available: true, env: { tasklist: '/t.exe', powershell: '/p.exe' } }),
      tracked: () => ({ playId: 42, fileId: 59, name: 'Film.mkv', port: 47318, password: PW, state: 'paused', positionS: 1201, pausedSince: new Date(T.getTime() - 260_000), silentSince: null, hung: false }),
      makeLister: () => ({ list: async () => listing.value }),
      makeEvents: () => null,
      makeGpuEvents: () =>
        gpu === null
          ? null
          : {
              read: async (from, to) => {
                gpu.windows.push([from.toISOString(), to.toISOString()]);
                return gpu.result;
              },
            },
      now: () => clock.now,
      log: (l) => lines.push(l),
    });
    const records = (): HealthRecord[] => new HealthLog(dir, HOST).readTail(50_000_000);
    return { m, clock, lines, listing, records };
  }

  it('writes one gpu_reset line per driver event while a vlc.exe exists, with the pids and the paused play, and never twice', async () => {
    const gpu = { result: { kind: 'ok', events: [RESET] } as GpuEventsResult, windows: [] as Array<[string, string]> };
    const { m, clock, lines, listing, records } = setup(gpu);
    await m.start();
    await m.sampleNow();
    clock.now = new Date(T.getTime() + 30_000);
    await m.sampleNow();
    const resets = records().filter((r) => r.kind === 'gpu_reset');
    expect(resets).toHaveLength(1);
    expect(resets[0]).toMatchObject({ time: RESET.time, event_id: 4101, message: RESET_MESSAGE, vlc_pids: [17984], play: { play_id: 42, state: 'paused', paused_s: 260 } });
    expect(gpu.windows[0]).toEqual(['2026-11-15T00:07:30.000Z', '2026-11-15T00:10:00.000Z']);
    expect(lines.filter((l) => l.includes('display driver event 4101'))).toHaveLength(1);
    expect(m.report(10).gpu_resets).toHaveLength(1);

    listing.value = { kind: 'ok', detail: true, processes: [] };
    const reads = gpu.windows.length;
    await m.sampleNow();
    expect(gpu.windows).toHaveLength(reads);
    await m.close();
  });

  it('a video stall start line names the driver events of the hour before; the end line follows it', async () => {
    const gpu = { result: { kind: 'ok', events: [RESET] } as GpuEventsResult, windows: [] as Array<[string, string]> };
    const { m, clock, records } = setup(gpu);
    await m.start();
    const base = { pid: 17984, port: 47318, playId: 42, fileId: 59, name: 'Film.mkv', positionS: 1287, stalledSince: new Date(T.getTime() - 15_000) };
    m.onVideoStall({ ...base, phase: 'start' });
    clock.now = new Date(T.getTime() + 45_000);
    m.onVideoStall({ ...base, phase: 'end', outcome: 'exited' });
    await m.close();
    const stalls = records().filter((r) => r.kind === 'video_stall');
    expect(stalls.map((r) => (r.kind === 'video_stall' ? [r.phase, r.outcome, r.stalled_s, r.gpu_events.length] : null))).toEqual([
      ['start', null, 60, 1],
      ['end', 'exited', 60, 0],
    ]);
    expect(gpu.windows[0]![0]).toBe('2026-11-14T23:09:45.000Z');
    expect(m.report(10).stalls).toHaveLength(2);
  });

  it('keeps sampling when the driver events cannot be read, saying so once, and reads none without PowerShell', async () => {
    const bad = setup({ result: { kind: 'error', message: 'powershell.exe exited 1' }, windows: [] });
    await bad.m.start();
    expect(await bad.m.sampleNow()).toBe(1);
    expect(await bad.m.sampleNow()).toBe(1);
    expect(bad.lines.filter((l) => l.includes('display-driver events failed'))).toHaveLength(1);
    await bad.m.close();
    const none = setup(null);
    await none.m.start();
    expect(await none.m.sampleNow()).toBe(1);
    none.m.onVideoStall({ pid: null, port: 47318, playId: 42, fileId: 59, name: 'Film.mkv', positionS: 1, stalledSince: T, phase: 'start' });
    await none.m.close();
    expect(none.records().filter((r) => r.kind === 'video_stall')).toHaveLength(1);
  });
});
