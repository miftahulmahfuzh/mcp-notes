import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  detectRevealEnv,
  EXPLORER_FALLBACK,
  explorerArgs,
  findOnPath,
  onceAsync,
  performReveal,
  resolveExplorer,
  runWslpath,
  spawnDetached,
  type DetectProbe,
  type RevealDeps,
  type RevealEnv,
  type RevealTarget,
  type SpawnFn,
} from '../../src/http/reveal.js';

const INTEROP = '/proc/sys/fs/binfmt_misc/WSLInterop';
const INTEROP_LATE = '/proc/sys/fs/binfmt_misc/WSLInterop-late';
const UNIT_PATH = '/home/u/.nvm/versions/node/v22/bin:/usr/local/bin:/usr/bin:/bin';

function fakeProbe(opts: {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  files?: string[];
  execs?: string[];
}): DetectProbe {
  const files = new Set(opts.files ?? []);
  const execs = new Set(opts.execs ?? []);
  return {
    platform: opts.platform ?? 'linux',
    env: opts.env ?? { PATH: UNIT_PATH },
    exists: async (p) => files.has(p) || execs.has(p),
    executable: async (p) => execs.has(p),
  };
}

/** A WSL box under the systemd unit: interop on, wslpath in /usr/bin, explorer only under /mnt/c. */
function wslProbe(overrides: { env?: Record<string, string | undefined>; files?: string[]; execs?: string[] } = {}) {
  return fakeProbe({
    env: overrides.env ?? { PATH: UNIT_PATH },
    files: overrides.files ?? [INTEROP],
    execs: overrides.execs ?? ['/usr/bin/wslpath', EXPLORER_FALLBACK],
  });
}

describe('detectRevealEnv', () => {
  it('finds wslpath on PATH and falls back to /mnt/c/Windows/explorer.exe (the systemd unit case)', async () => {
    expect(await detectRevealEnv(wslProbe())).toEqual({ explorer: EXPLORER_FALLBACK, wslpath: '/usr/bin/wslpath' });
  });

  it('is null off Linux', async () => {
    const probe = fakeProbe({ platform: 'darwin', files: [INTEROP], execs: ['/usr/bin/wslpath', EXPLORER_FALLBACK] });
    expect(await detectRevealEnv(probe)).toBeNull();
  });

  it('is null on Linux without WSL interop registered', async () => {
    expect(await detectRevealEnv(wslProbe({ files: [] }))).toBeNull();
  });

  it('accepts the WSLInterop-late binfmt entry', async () => {
    expect(await detectRevealEnv(wslProbe({ files: [INTEROP_LATE] }))).not.toBeNull();
  });

  it('is null when wslpath is not on PATH', async () => {
    expect(await detectRevealEnv(wslProbe({ execs: [EXPLORER_FALLBACK] }))).toBeNull();
    expect(await detectRevealEnv(wslProbe({ env: { PATH: '/opt/bin' } }))).toBeNull();
  });

  it('is null when no explorer can be found', async () => {
    expect(await detectRevealEnv(wslProbe({ execs: ['/usr/bin/wslpath'] }))).toBeNull();
  });

  it('is null (never throws) when the probe throws', async () => {
    const probe: DetectProbe = {
      ...wslProbe(),
      exists: async () => {
        throw new Error('EACCES');
      },
    };
    await expect(detectRevealEnv(probe)).resolves.toBeNull();
  });
});

describe('resolveExplorer', () => {
  const pathExplorer = '/mnt/c/WINDOWS/explorer.exe';
  const winPath = `${UNIT_PATH}:/mnt/c/WINDOWS`;

  it('prefers NOTESD_EXPLORER_BIN over PATH and the fallback', async () => {
    const probe = wslProbe({
      env: { PATH: winPath, NOTESD_EXPLORER_BIN: '/opt/win/explorer.exe' },
      execs: ['/usr/bin/wslpath', '/opt/win/explorer.exe', pathExplorer, EXPLORER_FALLBACK],
    });
    expect(await resolveExplorer(probe)).toBe('/opt/win/explorer.exe');
  });

  it('treats a NOTESD_EXPLORER_BIN that names nothing executable as authoritative (no fallback)', async () => {
    const probe = wslProbe({
      env: { PATH: winPath, NOTESD_EXPLORER_BIN: '/nope/explorer.exe' },
      execs: ['/usr/bin/wslpath', pathExplorer, EXPLORER_FALLBACK],
    });
    expect(await resolveExplorer(probe)).toBeNull();
    expect(await detectRevealEnv(probe)).toBeNull();
  });

  it('looks a bare NOTESD_EXPLORER_BIN name up on PATH', async () => {
    const probe = wslProbe({
      env: { PATH: `${UNIT_PATH}:/opt/win`, NOTESD_EXPLORER_BIN: 'myexplorer.exe' },
      execs: ['/usr/bin/wslpath', '/opt/win/myexplorer.exe', EXPLORER_FALLBACK],
    });
    expect(await resolveExplorer(probe)).toBe('/opt/win/myexplorer.exe');
  });

  it('ignores a blank NOTESD_EXPLORER_BIN', async () => {
    const probe = wslProbe({ env: { PATH: UNIT_PATH, NOTESD_EXPLORER_BIN: '  ' } });
    expect(await resolveExplorer(probe)).toBe(EXPLORER_FALLBACK);
  });

  it('prefers explorer.exe on PATH over the /mnt/c fallback', async () => {
    const probe = wslProbe({ env: { PATH: winPath }, execs: ['/usr/bin/wslpath', pathExplorer, EXPLORER_FALLBACK] });
    expect(await resolveExplorer(probe)).toBe(pathExplorer);
  });

  it('uses the fallback when it exists even if not marked executable', async () => {
    const probe = wslProbe({ files: [INTEROP, EXPLORER_FALLBACK], execs: ['/usr/bin/wslpath'] });
    expect(await resolveExplorer(probe)).toBe(EXPLORER_FALLBACK);
  });

  it('is null when nothing resolves', async () => {
    expect(await resolveExplorer(wslProbe({ execs: ['/usr/bin/wslpath'] }))).toBeNull();
  });
});

describe('findOnPath', () => {
  it('walks PATH in order, skipping empty entries', async () => {
    const execs = new Set(['/b/tool', '/c/tool']);
    const executable = async (p: string) => execs.has(p);
    expect(await findOnPath('tool', { PATH: '::/a:/b:/c' }, executable)).toBe('/b/tool');
  });

  it('is null with no PATH', async () => {
    expect(await findOnPath('tool', {}, async () => true)).toBeNull();
  });
});

describe('onceAsync', () => {
  it('runs the function once, also for concurrent callers', async () => {
    const fn = vi.fn(async () => ({ explorer: 'e', wslpath: 'w' }) satisfies RevealEnv);
    const once = onceAsync(fn);
    const [a, b] = await Promise.all([once(), once()]);
    const c = await once();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(c).toBe(a);
  });
});

describe('runWslpath', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-reveal-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function script(name: string, body: string): Promise<string> {
    const file = path.join(dir, name);
    await writeFile(file, `#!/bin/sh\n${body}\n`);
    await chmod(file, 0o755);
    return file;
  }

  it('runs `<bin> -w <abs>` and returns the trimmed stdout', async () => {
    const bin = await script('echo-args', `printf '%s|%s\\n' "$1" "$2"`);
    expect(await runWslpath(bin, '/home/u/data/images/2026/10/A B.png')).toBe('-w|/home/u/data/images/2026/10/A B.png');
  });

  it('rejects when the binary prints nothing', async () => {
    const bin = await script('silent', 'exit 0');
    await expect(runWslpath(bin, '/x.png')).rejects.toThrow(/printed nothing/);
  });

  it('rejects when the binary fails', async () => {
    const bin = await script('fails', 'echo nope >&2; exit 3');
    await expect(runWslpath(bin, '/x.png')).rejects.toThrow();
  });

  it('gives up after the timeout', async () => {
    const bin = await script('hangs', 'sleep 5');
    const started = Date.now();
    await expect(runWslpath(bin, '/x.png', 200)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

/** A ChildProcess stand-in: emits only what the test tells it to. */
function fakeChild(): ChildProcess & { unref: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), { unref: vi.fn() }) as unknown as ChildProcess & {
    unref: ReturnType<typeof vi.fn>;
  };
}

describe('spawnDetached', () => {
  it('spawns detached with stdio ignored and resolves on spawn, without waiting for exit', async () => {
    const child = fakeChild();
    const calls: Array<[string, string[], SpawnOptions]> = [];
    const spawnFn: SpawnFn = (cmd, args, options) => {
      calls.push([cmd, args, options]);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    };
    // The fake child never emits 'exit' or 'close': resolving proves the exit is not awaited.
    await expect(spawnDetached('/mnt/c/Windows/explorer.exe', ['/select,C:\\x.png'], spawnFn)).resolves.toBeUndefined();
    expect(calls).toEqual([['/mnt/c/Windows/explorer.exe', ['/select,C:\\x.png'], { detached: true, stdio: 'ignore' }]]);
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
  });

  it('rejects on the error event', async () => {
    const child = fakeChild();
    const spawnFn: SpawnFn = () => {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn explorer.exe ENOENT'), { code: 'ENOENT' })));
      return child;
    };
    await expect(spawnDetached('explorer.exe', [], spawnFn)).rejects.toThrow(/ENOENT/);
  });

  it('rejects when spawn throws synchronously', async () => {
    const spawnFn: SpawnFn = () => {
      throw new TypeError('bad argument');
    };
    await expect(spawnDetached('explorer.exe', [], spawnFn)).rejects.toThrow(/bad argument/);
  });

  it('ignores a non-zero exit code (explorer.exe exits 1 on success)', async () => {
    await expect(spawnDetached(process.execPath, ['-e', 'process.exit(1)'])).resolves.toBeUndefined();
  });

  it('rejects a binary that does not exist', async () => {
    await expect(spawnDetached('/nonexistent/explorer.exe', ['/select,C:\\x'])).rejects.toThrow(/ENOENT/);
  });
});

describe('explorerArgs', () => {
  it('is one argument, /select, glued to the path', () => {
    expect(explorerArgs('\\\\wsl.localhost\\Ubuntu\\home\\u\\My Pics\\a.png')).toEqual([
      '/select,\\\\wsl.localhost\\Ubuntu\\home\\u\\My Pics\\a.png',
    ]);
  });
});

describe('performReveal', () => {
  const env: RevealEnv = { explorer: EXPLORER_FALLBACK, wslpath: '/usr/bin/wslpath' };
  const target: RevealTarget = {
    originalPath: '/home/u/mcp-notes-data/images/2026/10/A-B32.png',
    available: true,
    host: 'laptop',
  };
  const WIN = '\\\\wsl.localhost\\Ubuntu\\home\\u\\mcp-notes-data\\images\\2026\\10\\A-B32.png';

  function fakeDeps(over: Partial<RevealDeps> = {}) {
    return {
      detect: vi.fn(over.detect ?? (async (): Promise<RevealEnv | null> => env)),
      wslpath: vi.fn(over.wslpath ?? (async (_abs: string): Promise<string> => WIN)),
      spawn: vi.fn(over.spawn ?? (async (_cmd: string, _args: string[]): Promise<void> => undefined)),
    } satisfies RevealDeps;
  }

  it('runs exactly `explorer.exe /select,<wslpath -w original>` and answers 202', async () => {
    const deps = fakeDeps();
    expect(await performReveal(target, deps)).toEqual({ status: 202, body: { ok: true } });
    expect(deps.wslpath).toHaveBeenCalledWith(target.originalPath);
    expect(deps.spawn).toHaveBeenCalledTimes(1);
    expect(deps.spawn).toHaveBeenCalledWith(EXPLORER_FALLBACK, [`/select,${WIN}`]);
  });

  it('404 not_found for an unknown image, before detecting anything', async () => {
    const deps = fakeDeps();
    expect(await performReveal(null, deps)).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(deps.detect).not.toHaveBeenCalled();
  });

  it('404 not_on_this_machine with the host when the original is elsewhere', async () => {
    const deps = fakeDeps();
    expect(await performReveal({ ...target, available: false, host: 'desktop' }, deps)).toEqual({
      status: 404,
      body: { error: 'not_on_this_machine', host: 'desktop' },
    });
    expect(deps.wslpath).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('409 reveal_unavailable off WSL', async () => {
    const deps = fakeDeps({ detect: async () => null });
    expect(await performReveal(target, deps)).toEqual({ status: 409, body: { error: 'reveal_unavailable' } });
    expect(deps.wslpath).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('500 spawn_failed when spawn errors', async () => {
    const deps = fakeDeps({
      spawn: async () => {
        throw new Error('spawn /mnt/c/Windows/explorer.exe ENOENT');
      },
    });
    expect(await performReveal(target, deps)).toEqual({
      status: 500,
      body: { error: 'spawn_failed', message: 'spawn /mnt/c/Windows/explorer.exe ENOENT' },
    });
  });

  it('500 spawn_failed when wslpath fails, and nothing is spawned', async () => {
    const deps = fakeDeps({
      wslpath: async () => {
        throw new Error('timed out');
      },
    });
    expect(await performReveal(target, deps)).toEqual({
      status: 500,
      body: { error: 'spawn_failed', message: 'wslpath failed: timed out' },
    });
    expect(deps.spawn).not.toHaveBeenCalled();
  });
});

describe('reveal modes', () => {
  it('selects by default and opens a folder in open mode', () => {
    expect(explorerArgs('C:\\x\\a.txt')).toEqual(['/select,C:\\x\\a.txt']);
    expect(explorerArgs('C:\\x\\a.txt', 'select')).toEqual(['/select,C:\\x\\a.txt']);
    expect(explorerArgs('C:\\x', 'open')).toEqual(['C:\\x']);
  });

  it('performReveal in open mode spawns explorer with the folder and no /select', async () => {
    const spawn = vi.fn(async (_cmd: string, _args: string[]): Promise<void> => undefined);
    const deps: RevealDeps = {
      detect: async () => ({ explorer: 'explorer.exe', wslpath: '/usr/bin/wslpath' }),
      wslpath: async (abs) => `W:${abs}`,
      spawn,
    };
    const target: RevealTarget = { originalPath: '/data/files/A-B32', available: true, host: 'h' };
    expect(await performReveal(target, deps, 'open')).toEqual({ status: 202, body: { ok: true } });
    expect(spawn).toHaveBeenCalledWith('explorer.exe', ['W:/data/files/A-B32']);
  });
});
