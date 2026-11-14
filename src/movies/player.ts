import { access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { MoviesConfig } from '../config.js';
import type { movieFiles } from '../db/schema.js';
import { nodeProbe, onceAsync, runWslpath, type DetectProbe } from '../http/reveal.js';
import type { MoviesRepo } from './repo.js';
import type { MoviesService } from './service.js';
import { resumePosition } from './state.js';
import { curlStatusReader, type VlcEndpoint, type VlcState, type VlcStatus, type VlcStatusReader } from './vlc/http.js';
import {
  detectPlayerEnv,
  newHttpPassword,
  spawnVlcLauncher,
  type PlayerDetection,
  type PlayerEnv,
  type PlayerUnavailableReason,
  type VlcLauncher,
} from './vlc/launch.js';
import { tmdbResolver } from './sync.js';
import { nodeRecentsFs, recentsSyncHook, type RecentsFs } from './vlc/recents.js';
import type { HangEvent, HangOutcome, PidCheck, PlayerHealthLink, TrackedVlc } from './vlc/health.js';

type FileRow = typeof movieFiles.$inferSelect;

/** Ports tried from `config.movies.vlc.httpPort`: P, P+1 .. P+9. */
export const PORT_CANDIDATES = 10;
/** How long VLC gets to bring its HTTP interface up after launch. */
export const READY_TIMEOUT_MS = 20_000;
export const READY_INTERVAL_MS = 500;
/** After pl_play: how long to wait for `playing` with a known length before seeking anyway. */
export const PLAYING_TIMEOUT_MS = 3_000;
/** VLC within this many seconds of the resume point needs no seek. */
export const SEEK_TOLERANCE_S = 5;
/** Consecutive unreadable polls (curl timeouts etc.) after which the play is ended. */
export const MAX_READ_ERRORS = 6;
/**
 * Movies phase 9: silent polls in a row (curl timeout, or no listener while the vlc.exe still exists)
 * before a VLC whose process is alive counts as hung. A hung VLC keeps its play open at the last
 * position read, however long it stays silent. Two, not one, so a VLC that is closing (socket shut,
 * process not yet gone) does not log a false hang.
 */
export const HANG_AFTER_SILENT_POLLS = 2;

export type PlayErrorCode = 'not_found' | 'not_on_this_machine' | 'player_unavailable' | 'file_missing';

export class PlayError extends Error {
  readonly code: PlayErrorCode;
  /** not_on_this_machine: the host that holds the file. */
  readonly host: string | null;
  /** player_unavailable: why. */
  readonly reason: PlayerUnavailableReason | null;

  constructor(code: PlayErrorCode, message: string, detail: { host?: string; reason?: PlayerUnavailableReason } = {}) {
    super(message);
    this.name = 'PlayError';
    this.code = code;
    this.host = detail.host ?? null;
    this.reason = detail.reason ?? null;
  }
}

const UNAVAILABLE_MESSAGE: Record<PlayerUnavailableReason, string> = {
  not_linux: 'Playback needs notesd running in WSL; this is not Linux.',
  no_interop: 'WSL interop is off, so notesd cannot start Windows programs.',
  no_wslpath: 'wslpath is not on PATH.',
  no_vlc: 'vlc.exe was not found (set NOTESD_VLC_BIN).',
  no_curl: 'The Windows curl.exe was not found (set NOTESD_CURL_EXE).',
  no_free_port: 'Every VLC HTTP port notesd may use is taken.',
  launch_failed: 'vlc.exe could not be started.',
};

export type PlayerRepo = Pick<MoviesRepo, 'fileById' | 'lastPlay' | 'startPlay' | 'updatePlay' | 'endPlay' | 'closeOpenPlays'>;

export interface MoviePlayerDeps {
  repo: PlayerRepo;
  /** This machine (`MoviesService.host`). */
  host: string;
  /** `config.movies.vlc.httpPort`: the first port tried. */
  httpPort: number;
  /** `config.movies.vlc.pollMs`. */
  pollMs: number;
  /** Cached detection (buildMoviePlayback wraps detectPlayerEnv in onceAsync). */
  detect: () => Promise<PlayerDetection>;
  launcher: VlcLauncher;
  reader: VlcStatusReader;
  /** Linux path -> Windows path. Default: `wslpath -w`. */
  wslpath?: (wslpathBin: string, abs: string) => Promise<string>;
  /** Default: fs.access. */
  exists?: (abs: string) => Promise<boolean>;
  /** Default: newHttpPassword. */
  password?: () => string;
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
  playingTimeoutMs?: number;
  /** Called when a play starts or ends, never per poll (buildMoviePlayback emits MovieEvents `changed('play')`). */
  onChange?: (file: FileRow) => void;
  /**
   * Movies phase 9: the VLC health monitor. Asked whether a silent VLC's process still exists, and
   * told when a hang starts and ends (R8.3). Absent: Phase 5's rules (exit 7 ends the play at once,
   * MAX_READ_ERRORS curl errors end it).
   */
  health?: PlayerHealthLink;
  /** Default `new Date()`: the paused and silent clocks. */
  now?: () => Date;
  log?: (line: string) => void;
}

/** POST /api/movies/files/:fileId/play -> 202 { ok: true, play }. */
export interface PlayStarted {
  play_id: number;
  file_id: number;
  title_id: string | null;
  name: string;
  start_position: number;
  port: number;
  tracking: boolean;
  note: 'http_timeout' | null;
}

/** GET /api/movies/player -> current. */
export interface PlayerSnapshot {
  play_id: number;
  file_id: number;
  title_id: string | null;
  name: string;
  port: number;
  state: VlcState;
  position: number;
  duration: number | null;
  started_at: string;
  last_read_at: string | null;
}

export interface PlayerAvailability {
  available: boolean;
  reason: PlayerUnavailableReason | null;
}

type EndWhy = 'exited' | 'unreachable' | 'replaced' | 'shutdown';

interface Tracked {
  playId: number;
  file: FileRow;
  env: PlayerEnv;
  ep: VlcEndpoint;
  startedAt: Date;
  state: VlcState;
  position: number;
  duration: number | null;
  lastReadAt: Date | null;
  /** Silent polls in a row (curl errors, and exit 7 while the process lives). */
  errors: number;
  timer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
  ended: boolean;
  /** The first poll of the current pause that read `paused`; null while not paused. */
  pausedSince: Date | null;
  /** The first silent poll of the current silence; null while VLC answers. */
  silentSince: Date | null;
  /** Between a hang's start and end lines. */
  hung: boolean;
  /** The vlc.exe pid the monitor matched when the hang started. */
  hangPid: number | null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function pathExists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Plays movie files in the Windows VLC and tracks one play at a time (R4.1-R4.3). It never stops,
 * kills or reuses a VLC: a new play ends the tracking of the previous one and leaves that VLC open.
 */
export class MoviePlayer {
  readonly host: string;
  private tracked: Tracked | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly deps: MoviePlayerDeps) {
    this.host = deps.host;
  }

  async availability(): Promise<PlayerAvailability> {
    const d = await this.deps.detect();
    return d.available ? { available: true, reason: null } : { available: false, reason: d.reason };
  }

  /** Daemon start, before listening: close the plays a previous process left open. Returns how many. */
  async start(): Promise<number> {
    return this.deps.repo.closeOpenPlays(this.host);
  }

  /** Plays are serialized so two clicks never race for a port or the tracked slot. */
  play(fileId: number): Promise<PlayStarted> {
    const run = this.queue.then(() => this.playNow(fileId));
    this.queue = run.catch(() => undefined);
    return run;
  }

  current(): PlayerSnapshot | null {
    const t = this.tracked;
    if (t === null) return null;
    return {
      play_id: t.playId,
      file_id: t.file.id,
      title_id: t.file.titleId,
      name: t.file.name,
      port: t.ep.port,
      state: t.state,
      position: t.position,
      duration: t.duration,
      started_at: t.startedAt.toISOString(),
      last_read_at: t.lastReadAt === null ? null : t.lastReadAt.toISOString(),
    };
  }

  /**
   * Movies phase 9: the followed play as the health monitor samples it. Holds the per-launch
   * password, which the monitor matches against vlc.exe command lines in memory and never logs.
   * Not a wire type: GET /api/movies/player keeps current().
   */
  healthView(): TrackedVlc | null {
    const t = this.tracked;
    if (t === null) return null;
    return {
      playId: t.playId,
      fileId: t.file.id,
      name: t.file.name,
      port: t.ep.port,
      password: t.ep.password,
      state: t.state,
      positionS: t.position,
      pausedSince: t.pausedSince,
      silentSince: t.silentSince,
      hung: t.hung,
    };
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** Daemon stop: finish a play in progress, then end the tracked play at its last position. VLC stays open. */
  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
    const t = this.tracked;
    if (t !== null) await this.finish(t, 'shutdown');
  }

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.log(l)))(line);
  }

  private async playNow(fileId: number): Promise<PlayStarted> {
    if (this.closed) throw new PlayError('player_unavailable', 'notesd is shutting down.', { reason: 'launch_failed' });
    const repo = this.deps.repo;
    const file = await repo.fileById(fileId);
    if (file === null) throw new PlayError('not_found', `No movie file ${fileId}.`);
    if (file.host !== this.host) {
      throw new PlayError('not_on_this_machine', `${file.name} is on ${file.host}; play it there.`, { host: file.host });
    }
    if (file.deletedAt !== null || !(await (this.deps.exists ?? pathExists)(file.path))) {
      throw new PlayError('file_missing', `${file.name} is no longer on disk.`);
    }
    const detection = await this.deps.detect();
    if (!detection.available) {
      throw new PlayError('player_unavailable', UNAVAILABLE_MESSAGE[detection.reason], { reason: detection.reason });
    }
    const env = detection.env;
    const start = resumePosition(file, await repo.lastPlay(file.id));
    let winPath: string;
    try {
      winPath = await (this.deps.wslpath ?? runWslpath)(env.wslpath, file.path);
    } catch (err) {
      throw new PlayError('player_unavailable', `wslpath failed: ${message(err)}`, { reason: 'launch_failed' });
    }

    if (this.tracked !== null) await this.finish(this.tracked, 'replaced');

    const password = (this.deps.password ?? newHttpPassword)();
    const port = await this.freePort(env, password);
    if (port === null) {
      const last = this.deps.httpPort + PORT_CANDIDATES - 1;
      throw new PlayError('player_unavailable', `VLC HTTP ports ${this.deps.httpPort}-${last} are all in use.`, { reason: 'no_free_port' });
    }
    try {
      await this.deps.launcher.launch(env, { winPath, port, password, startTime: start });
    } catch (err) {
      throw new PlayError('player_unavailable', `vlc.exe did not start: ${message(err)}`, { reason: 'launch_failed' });
    }

    const play = await repo.startPlay({ fileId: file.id, host: this.host, source: 'live', startedAt: new Date(), startPositionS: start, durationS: file.durationS });
    this.deps.onChange?.(file);
    const ep: VlcEndpoint = { port, password };
    const base = { play_id: play.id, file_id: file.id, title_id: file.titleId, name: file.name, start_position: start, port };

    const ready = await this.waitReady(env, ep);
    if (ready === null) {
      await repo.endPlay(play.id, { positionS: start, durationS: file.durationS }, new Date());
      this.deps.onChange?.(file);
      this.log(`[movies] VLC on port ${port} never answered; play ${play.id} (${file.name}) kept at ${start} s without tracking`);
      return { ...base, tracking: false, note: 'http_timeout' };
    }
    const status = await this.ensurePlaying(env, ep, ready, start);
    const t: Tracked = {
      playId: play.id,
      file,
      env,
      ep,
      startedAt: play.startedAt,
      state: status.state,
      position: start,
      duration: status.length > 0 ? status.length : file.durationS,
      lastReadAt: null,
      errors: 0,
      timer: null,
      inFlight: null,
      ended: false,
      pausedSince: status.state === 'paused' ? this.now() : null,
      silentSince: null,
      hung: false,
      hangPid: null,
    };
    this.tracked = t;
    if (this.closed) await this.finish(t, 'shutdown');
    else this.schedule(t);
    return { ...base, tracking: true, note: null };
  }

  /**
   * A port is free only when nothing listens on it; any answer (401 included) or a silent listener
   * means taken. Each free candidate costs one connect timeout (CURL_CONNECT_TIMEOUT_S).
   */
  private async freePort(env: PlayerEnv, password: string): Promise<number | null> {
    for (let i = 0; i < PORT_CANDIDATES; i++) {
      const port = this.deps.httpPort + i;
      const r = await this.deps.reader.status(env.curl, { port, password });
      if (r.kind === 'gone') return port;
    }
    return null;
  }

  private async waitReady(env: PlayerEnv, ep: VlcEndpoint): Promise<VlcStatus | null> {
    const deadline = Date.now() + (this.deps.readyTimeoutMs ?? READY_TIMEOUT_MS);
    for (;;) {
      const r = await this.deps.reader.status(env.curl, ep);
      if (r.kind === 'ok') return r.status;
      if (r.kind === 'unauthorized') return null; // someone else took the port between the probe and the launch
      if (Date.now() >= deadline) return null;
      await delay(this.deps.readyIntervalMs ?? READY_INTERVAL_MS);
    }
  }

  /** Make sure VLC plays (pl_play when it does not), then seek to the resume point when it is off by more than the tolerance. */
  private async ensurePlaying(env: PlayerEnv, ep: VlcEndpoint, first: VlcStatus, start: number): Promise<VlcStatus> {
    let status = first;
    const interval = this.deps.readyIntervalMs ?? READY_INTERVAL_MS;
    if (status.state !== 'playing') {
      const r = await this.deps.reader.command(env.curl, ep, { command: 'pl_play' });
      if (r.kind === 'ok') status = r.status;
    }
    const deadline = Date.now() + (this.deps.playingTimeoutMs ?? PLAYING_TIMEOUT_MS);
    while (!(status.state === 'playing' && status.length > 0) && Date.now() < deadline) {
      await delay(interval);
      const r = await this.deps.reader.status(env.curl, ep);
      if (r.kind === 'ok') status = r.status;
      else if (r.kind !== 'error') break;
    }
    if (start > 0 && Math.abs(status.time - start) > SEEK_TOLERANCE_S) {
      const r = await this.deps.reader.command(env.curl, ep, { command: 'seek', val: start });
      if (r.kind === 'ok') status = r.status;
    }
    return status;
  }

  private schedule(t: Tracked): void {
    t.timer = setTimeout(() => {
      t.timer = null;
      t.inFlight = this.tick(t)
        .catch((err: unknown) => this.log(`[movies] poll of play ${t.playId} failed: ${message(err)}`))
        .finally(() => {
          t.inFlight = null;
          if (!t.ended) this.schedule(t);
        });
    }, this.deps.pollMs);
    t.timer.unref();
  }

  private async tick(t: Tracked): Promise<void> {
    if (t.ended) return;
    const r = await this.deps.reader.status(t.env.curl, t.ep);
    if (t.ended) return;
    switch (r.kind) {
      case 'ok': {
        t.errors = 0;
        this.endHang(t, 'answered');
        t.silentSince = null;
        t.state = r.status.state;
        if (r.status.state === 'paused') t.pausedSince ??= this.now();
        else t.pausedSince = null;
        // Stopped (user pressed stop, or the media ended) reads time 0 / length 0: keep the last real position.
        if (r.status.state === 'stopped') return;
        t.position = r.status.time;
        if (r.status.length > 0) t.duration = r.status.length;
        t.lastReadAt = new Date();
        await this.deps.repo.updatePlay(t.playId, { positionS: t.position, durationS: t.duration });
        return;
      }
      case 'unauthorized':
        await this.finish(t, 'exited', true);
        return;
      case 'gone':
        if (this.deps.health === undefined) {
          await this.finish(t, 'exited', true);
          return;
        }
        await this.onSilent(t, 'refused');
        return;
      case 'error':
        await this.onSilent(t, 'error');
        return;
    }
  }

  /**
   * Movies phase 9, the hang rule (R8.3). A silent poll never writes a position. With the monitor:
   * process gone -> the play ends `exited`; alive for HANG_AFTER_SILENT_POLLS polls -> one hang
   * start line, and the play stays open at its last position; unknown -> Phase 5's rules.
   */
  private async onSilent(t: Tracked, how: 'refused' | 'error'): Promise<void> {
    t.errors += 1;
    t.silentSince ??= this.now();
    const health = this.deps.health;
    if (health !== undefined && (how === 'refused' || t.errors >= HANG_AFTER_SILENT_POLLS)) {
      const check: PidCheck = await health.processAlive(t.ep);
      if (t.ended) return;
      if (check.kind === 'gone' || (check.kind === 'unknown' && how === 'refused')) {
        await this.finish(t, 'exited', true);
        return;
      }
      if (check.kind === 'alive') {
        if (t.errors >= HANG_AFTER_SILENT_POLLS && !t.hung) this.startHang(t, check.pid);
        return;
      }
    }
    if (t.errors >= MAX_READ_ERRORS) await this.finish(t, 'unreachable', true);
  }

  private hangBase(t: Tracked): Omit<HangEvent, 'phase' | 'outcome'> {
    return {
      pid: t.hangPid,
      port: t.ep.port,
      playId: t.playId,
      fileId: t.file.id,
      name: t.file.name,
      positionS: t.position,
      silentSince: t.silentSince ?? this.now(),
    };
  }

  private startHang(t: Tracked, pid: number): void {
    t.hung = true;
    t.hangPid = pid;
    this.deps.health?.onHang({ ...this.hangBase(t), phase: 'start' });
    this.log(`[movies] VLC pid ${pid} of play ${t.playId} (${t.file.name}) stopped answering on port ${t.ep.port}; play kept at ${Math.round(t.position)} s`);
  }

  /** Writes the hang's end line once; a no-op when the play is not hung. */
  private endHang(t: Tracked, outcome: HangOutcome): void {
    if (!t.hung) return;
    this.deps.health?.onHang({ ...this.hangBase(t), phase: 'end', outcome });
    this.log(`[movies] VLC of play ${t.playId} (${t.file.name}) hang ended: ${outcome}`);
    t.hung = false;
    t.hangPid = null;
  }

  /** Ends tracking once: stop polling, close a hang, then close the play row at the last position read. */
  private async finish(t: Tracked, why: EndWhy, fromTick = false): Promise<void> {
    if (t.ended) return;
    t.ended = true;
    if (t.timer !== null) {
      clearTimeout(t.timer);
      t.timer = null;
    }
    if (this.tracked === t) this.tracked = null;
    this.endHang(t, why === 'exited' ? 'exited' : 'tracking_ended');
    if (!fromTick && t.inFlight !== null) await t.inFlight;
    await this.deps.repo.endPlay(t.playId, { positionS: t.position, durationS: t.duration }, new Date());
    this.deps.onChange?.(t.file);
    this.log(`[movies] play ${t.playId} (${t.file.name}) ended at ${Math.round(t.position)} s: ${why}`);
  }
}

/** The parts of MoviesService playback hangs off (Phase 3). */
export type PlaybackService = Pick<MoviesService, 'repo' | 'host' | 'tmdb' | 'events' | 'addSyncHook'>;

/** Seams for tests; the daemon passes `health` only. */
export interface PlaybackOverrides {
  probe?: DetectProbe;
  launcher?: VlcLauncher;
  reader?: VlcStatusReader;
  wslpath?: (wslpathBin: string, abs: string) => Promise<string>;
  recentsFs?: RecentsFs;
  /** Movies phase 9: the health monitor (the hang rule). */
  health?: PlayerHealthLink;
}

/**
 * The player for `deps.moviesPlayer`, and the `[RecentsMRL]` sync hook on the service when
 * `config.vlc.ini` is set. Builds nothing that runs: no detection, no process, until a play.
 */
export function buildMoviePlayback(service: PlaybackService, config: MoviesConfig, overrides: PlaybackOverrides = {}): MoviePlayer {
  const probe = overrides.probe ?? nodeProbe();
  const detect = onceAsync(() => detectPlayerEnv({ bin: config.vlc.bin, curlExe: config.vlc.curlExe }, probe));
  const player = new MoviePlayer({
    repo: service.repo,
    host: service.host,
    httpPort: config.vlc.httpPort,
    pollMs: config.vlc.pollMs,
    detect,
    launcher: overrides.launcher ?? spawnVlcLauncher({ extraArgs: config.vlc.extraArgs }),
    reader: overrides.reader ?? curlStatusReader(),
    ...(overrides.wslpath !== undefined ? { wslpath: overrides.wslpath } : {}),
    ...(overrides.health !== undefined ? { health: overrides.health } : {}),
    // Play start and end only: the web reloads its whole list on every `changed`.
    onChange: (file) => service.events.changed('play', { fileIds: [file.id], titleIds: file.titleId === null ? [] : [file.titleId] }),
  });
  if (config.vlc.ini !== null) {
    service.addSyncHook(
      recentsSyncHook({
        iniPath: config.vlc.ini,
        roots: config.roots,
        host: service.host,
        repo: service.repo,
        resolver: service.tmdb === null ? null : tmdbResolver(service.tmdb, null),
        fs: overrides.recentsFs ?? nodeRecentsFs,
      }),
    );
  }
  return player;
}
