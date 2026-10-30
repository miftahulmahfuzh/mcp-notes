> Adopted from `/home/miftah/.worktrees/mcp-notes/wall-editing/.workflows/orchestration/wall-editing/PLAN.md` phase 5. Source: `.workflows/plan/wall-editing/phase-5.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 5: Reveal in Explorer: capabilities + reveal endpoint

**Plan set:** `WALL_EDITING_PLAN.md`
**Analysis:** `docs/analyzer/20261030-153729-W7ED_code_analyzer.md`
**Satisfies:** R4 (server half: capabilities endpoint and `explorer.exe /select,<wslpath -w>` behind the own-Origin guard), R5 (this phase's own unit + integration tests)
**Depends on:** Phase 2 (`src/http/sameOrigin.ts` `sameOriginOnly`; `locateImage(deps, imageId)` keyed by image id; wire `Note.images[]`)
**Difficulty:** NORMAL
**Package:** `src/http`

---

## Goal

notesd gains `GET /api/capabilities` (`{ reveal: boolean }`, true only when the daemon runs under WSL with interop, `wslpath` and a resolvable `explorer.exe`) and `POST /api/images/:imageId/reveal`, which, for a same-origin request naming an image whose original is on this machine, converts the original's path with `wslpath -w` and starts `explorer.exe /select,<winPath>` detached, answering 202 as soon as the process has spawned. Explorer's exit code is never looked at and the request never waits for it. Every OS touch point (detect, wslpath, spawn) can be injected, so tests never start Explorer.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates (all in `src/http/reveal.ts`, new file):**
- `interface RevealEnv { explorer: string; wslpath: string }`
- `interface RevealDeps { detect(): Promise<RevealEnv | null>; wslpath(abs: string): Promise<string>; spawn(cmd: string, args: string[]): Promise<void> }` (exactly the contract shape)
- `interface RevealRoutesOptions { reveal?: RevealDeps }`
- `function revealRoutes(deps: AppDeps, opts?: RevealRoutesOptions): Hono` (contract signature)
- `interface DetectProbe { platform; env; exists(p); executable(p) }`, `function nodeProbe(): DetectProbe`
- `const WSL_INTEROP_FILES`, `const EXPLORER_FALLBACK = '/mnt/c/Windows/explorer.exe'`, `const EXPLORER_ENV = 'NOTESD_EXPLORER_BIN'`, `const WSLPATH_TIMEOUT_MS = 5000`
- `function findOnPath(name, env, executable): Promise<string | null>`
- `function resolveExplorer(probe): Promise<string | null>`
- `function detectRevealEnv(probe): Promise<RevealEnv | null>` (never throws; uncached)
- `function onceAsync<T>(fn): () => Promise<T>`
- `function runWslpath(bin, abs, timeoutMs?): Promise<string>` (`execFile(bin, ['-w', abs], { timeout })`)
- `type SpawnFn`, `function spawnDetached(cmd, args, spawnFn?): Promise<void>` (resolve on `'spawn'`, reject on `'error'`, `unref()`)
- `function explorerArgs(winPath): string[]` → `['/select,' + winPath]`
- `function defaultRevealDeps(): RevealDeps` (process-wide singleton; `detect` cached per process)
- `interface RevealTarget { originalPath: string; available: boolean; host: string | null }`, `type RevealOutcome`, `function performReveal(target, reveal): Promise<RevealOutcome>`
- HTTP: `GET /api/capabilities` → 200 `{ reveal: boolean }`; `POST /api/images/:imageId/reveal` (behind `sameOriginOnly`) → 202 `{ ok: true }` · 403 `{ error: 'forbidden_origin' }` (from phase 2's guard) · 404 `{ error: 'not_found' }` · 404 `{ error: 'not_on_this_machine', host }` · 409 `{ error: 'reveal_unavailable' }` · 500 `{ error: 'spawn_failed', message }`.

**Signature changes:** `CreateAppOptions` (`src/http/app.ts`) gains an optional `reveal?: RevealDeps` (additive; existing `createApp(deps)` / `createApp(deps, { chat })` callers unchanged).
**Requires (from earlier phases):**
- Phase 2: `src/http/sameOrigin.ts` exports `sameOriginOnly: MiddlewareHandler` returning 403 `{ error: 'forbidden_origin' }` unless the `Origin` header's origin equals the request URL's origin and the request host is loopback.
- Phase 2: `src/images/ingest.ts` still exports `imageDeps(app: AppDeps): ImageDeps` and `locateImage(deps: Pick<ImageDeps, 'dataDir' | 'records'>, imageId: string): Promise<LocatedImage | null>`, where `null` = unknown image id, and `LocatedImage` still carries `originalPath: string` (absolute), `available: boolean`, `host: string | null`. This phase reads only those three fields, so it does not care whether `deleted` / note state fields were renamed. Images that are removed or in a deleted note can be revealed too: any row whose file exists. This matches phase 2's serving rule, and the bin may want it.
- Phase 2: `src/http/app.ts` no longer defines `isLoopbackUrl` locally (it imports it from `sameOrigin.ts`); the two lines this phase adds are placed by anchor, not line number.
- Phase 2: `POST /api/images` answers `{ note, created }` with `note.images[0].id` (used by the integration test).
**Leaves alone (owned by others):** `src/http/images.ts`, `src/http/imageAccess.ts`, `src/http/sameOrigin.ts`, `src/images/*` (phase 2/3); `src/http/api.ts` (phase 4); `src/config.ts` (the env var is read directly in `nodeProbe`, no config key); `deploy/notesd.service` (unchanged, see Decisions in the index); `web/**` (phase 9); README (phase 10).

## Files

| File | Action | What changes |
|---|---|---|
| `src/http/reveal.ts` | create | detect / wslpath / spawn implementations, `performReveal`, `revealRoutes` |
| `src/http/app.ts` | modify | import + mount `revealRoutes` after `imageRoutes`, before `staticRoutes`; `CreateAppOptions.reveal`; header comment lists the new router |
| `tests/unit/reveal.test.ts` | create | detect rules, explorer resolution order, `onceAsync`, `runWslpath` argv/timeout, `spawnDetached` (resolve on spawn, reject on error, exit ignored, never awaits exit), `performReveal` outcomes and exact command line |
| `tests/integration/reveal.int.test.ts` | create | Origin 403s, 404s, 409, capabilities with injected detect, exact command line for a real uploaded image, spawn error → 500, mounting in the real `createApp` ahead of the static fallback |

## Implementation Steps

### Step 1: Create the reveal module
**File:** `src/http/reveal.ts` (new)
**Change:** The whole module. Design notes:
- `detectRevealEnv` takes a `DetectProbe` so the rules can be unit-tested without touching `/proc`. It catches every error and returns `null`: a capabilities call must never 500.
- Explorer resolution order (contract): `NOTESD_EXPLORER_BIN` → `explorer.exe` on `PATH` → `/mnt/c/Windows/explorer.exe` if it exists. A set, non-empty `NOTESD_EXPLORER_BIN` is **authoritative**. If it names nothing executable, detect returns `null` and does not fall back, so a wrong override shows up as "no reveal" instead of quietly running some other binary. A value containing `/` is checked as a path; a bare name is looked up on `PATH`.
- `wslpath` must resolve on `PATH` (the unit's PATH includes `/usr/bin`, `deploy/notesd.service:16`).
- `defaultRevealDeps()` is a module singleton so `detect` runs once per process (contract "cached per process"). Its `wslpath` uses the binary that detect resolved.
- `performReveal` does the 404 checks before `detect`, so a 404 never depends on the machine (the integration test relies on this to hit the real app without spawning anything). Then it runs detect (409), wslpath, and finally spawn. A wslpath failure is reported as `spawn_failed` too, because the contract has a single 500 code; its message says `wslpath failed: …`.
- `spawnDetached` resolves on the child's `'spawn'` event, so the request finishes as soon as Explorer has started. Exit is never listened for.

**Code:**
```ts
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';
import { imageDeps, locateImage } from '../images/ingest.js';
import { normalizeId } from '../notes/ids.js';
import { sameOriginOnly } from './sameOrigin.js';

/** What a working reveal needs: the two binaries, resolved to runnable paths. */
export interface RevealEnv {
  explorer: string;
  wslpath: string;
}

/** Every OS touch point of the reveal route. Tests inject fakes; the daemon uses defaultRevealDeps(). */
export interface RevealDeps {
  /** null when this process cannot open Windows Explorer (not WSL, no interop, no wslpath, no explorer). */
  detect(): Promise<RevealEnv | null>;
  /** Absolute Linux path -> Windows path (`wslpath -w`). */
  wslpath(abs: string): Promise<string>;
  /** Start `cmd args` detached. Resolves once the process has spawned; never waits for it to exit. */
  spawn(cmd: string, args: string[]): Promise<void>;
}

export interface RevealRoutesOptions {
  /** Defaults to defaultRevealDeps(): the real WSL detection, wslpath and spawn. */
  reveal?: RevealDeps;
}

/** The facts detectRevealEnv reads, so its rules can be tested without /proc or PATH. */
export interface DetectProbe {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  /** True when anything exists at p. */
  exists(p: string): Promise<boolean>;
  /** True when p is a regular file this process may execute. */
  executable(p: string): Promise<boolean>;
}

/** binfmt_misc entries WSL registers when Windows interop is on (the `-late` name on newer WSL builds). */
export const WSL_INTEROP_FILES = [
  '/proc/sys/fs/binfmt_misc/WSLInterop',
  '/proc/sys/fs/binfmt_misc/WSLInterop-late',
] as const;

/** Where explorer.exe lives when /mnt/c is not on PATH (the systemd unit's PATH never has it). */
export const EXPLORER_FALLBACK = '/mnt/c/Windows/explorer.exe';

/** Overrides explorer.exe resolution. Authoritative when set: a wrong value disables reveal. */
export const EXPLORER_ENV = 'NOTESD_EXPLORER_BIN';

export const WSLPATH_TIMEOUT_MS = 5000;

/** The probe for the running process. */
export function nodeProbe(): DetectProbe {
  return {
    platform: process.platform,
    env: process.env,
    async exists(p) {
      try {
        await access(p, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    async executable(p) {
      try {
        const info = await stat(p);
        if (!info.isFile()) return false;
        await access(p, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** First executable `<dir>/<name>` over the PATH entries in order; empty entries are skipped. */
export async function findOnPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  executable: (p: string) => Promise<boolean>,
): Promise<string | null> {
  for (const dir of (env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    const candidate = path.posix.join(dir, name);
    if (await executable(candidate)) return candidate;
  }
  return null;
}

/** NOTESD_EXPLORER_BIN, else explorer.exe on PATH, else /mnt/c/Windows/explorer.exe if it exists. */
export async function resolveExplorer(probe: DetectProbe): Promise<string | null> {
  const override = probe.env[EXPLORER_ENV]?.trim();
  if (override) {
    if (override.includes('/')) return (await probe.executable(override)) ? override : null;
    return findOnPath(override, probe.env, probe.executable);
  }
  const onPath = await findOnPath('explorer.exe', probe.env, probe.executable);
  if (onPath !== null) return onPath;
  return (await probe.exists(EXPLORER_FALLBACK)) ? EXPLORER_FALLBACK : null;
}

/** Linux + WSL interop registered + wslpath on PATH + explorer resolvable. Never throws. Not cached. */
export async function detectRevealEnv(probe: DetectProbe): Promise<RevealEnv | null> {
  try {
    if (probe.platform !== 'linux') return null;
    let interop = false;
    for (const file of WSL_INTEROP_FILES) {
      if (await probe.exists(file)) {
        interop = true;
        break;
      }
    }
    if (!interop) return null;
    const wslpath = await findOnPath('wslpath', probe.env, probe.executable);
    if (wslpath === null) return null;
    const explorer = await resolveExplorer(probe);
    if (explorer === null) return null;
    return { explorer, wslpath };
  } catch {
    return null;
  }
}

/** Run fn on the first call only; every call (concurrent ones included) gets the same promise. */
export function onceAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= fn();
    return pending;
  };
}

const execFileAsync = promisify(execFile);

/** `<bin> -w <abs>` with a timeout; the trimmed stdout is the Windows path. */
export async function runWslpath(bin: string, abs: string, timeoutMs: number = WSLPATH_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync(bin, ['-w', abs], { timeout: timeoutMs, encoding: 'utf8' });
  const out = stdout.trim();
  if (out === '') throw new Error(`wslpath printed nothing for ${abs}`);
  return out;
}

export type SpawnFn = (cmd: string, args: string[], options: SpawnOptions) => ChildProcess;

/**
 * Start a detached child that outlives nothing of ours: stdio ignored, unref'd.
 * Resolves on 'spawn', rejects on 'error'. The exit code is never read (explorer.exe exits 1 on success).
 */
export function spawnDetached(cmd: string, args: string[], spawnFn: SpawnFn = spawn): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnFn(cmd, args, { detached: true, stdio: 'ignore' });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', (err: Error) => {
      child.unref();
      reject(err);
    });
  });
}

/** explorer.exe's select switch: one argument, no space after the comma. */
export function explorerArgs(winPath: string): string[] {
  return ['/select,' + winPath];
}

let defaultDeps: RevealDeps | undefined;

/** The real RevealDeps, one per process, so WSL detection runs once. */
export function defaultRevealDeps(): RevealDeps {
  if (defaultDeps !== undefined) return defaultDeps;
  const detect = onceAsync(() => detectRevealEnv(nodeProbe()));
  defaultDeps = {
    detect,
    async wslpath(abs) {
      const env = await detect();
      if (env === null) throw new Error('WSL interop is not available');
      return runWslpath(env.wslpath, abs);
    },
    spawn: (cmd, args) => spawnDetached(cmd, args),
  };
  return defaultDeps;
}

/** The part of a located image the reveal needs (phase 2's LocatedImage satisfies it). */
export interface RevealTarget {
  /** Absolute path of the original under this machine's data dir. */
  originalPath: string;
  available: boolean;
  host: string | null;
}

export type RevealOutcome =
  | { status: 202; body: { ok: true } }
  | { status: 404; body: { error: 'not_found' } }
  | { status: 404; body: { error: 'not_on_this_machine'; host: string | null } }
  | { status: 409; body: { error: 'reveal_unavailable' } }
  | { status: 500; body: { error: 'spawn_failed'; message: string } };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 404s first (independent of the machine), then detect, wslpath, spawn. Success = spawned. */
export async function performReveal(target: RevealTarget | null, reveal: RevealDeps): Promise<RevealOutcome> {
  if (target === null) return { status: 404, body: { error: 'not_found' } };
  if (!target.available) return { status: 404, body: { error: 'not_on_this_machine', host: target.host } };
  const env = await reveal.detect();
  if (env === null) return { status: 409, body: { error: 'reveal_unavailable' } };
  let winPath: string;
  try {
    winPath = await reveal.wslpath(target.originalPath);
  } catch (err) {
    return { status: 500, body: { error: 'spawn_failed', message: `wslpath failed: ${errorMessage(err)}` } };
  }
  try {
    await reveal.spawn(env.explorer, explorerArgs(winPath));
  } catch (err) {
    return { status: 500, body: { error: 'spawn_failed', message: errorMessage(err) } };
  }
  return { status: 202, body: { ok: true } };
}

/**
 * GET /api/capabilities -> { reveal }.
 * POST /api/images/:imageId/reveal (own Origin only) -> opens Explorer with the original selected.
 * Takes an image id, never a path.
 */
export function revealRoutes(deps: AppDeps, opts: RevealRoutesOptions = {}): Hono {
  const reveal = opts.reveal ?? defaultRevealDeps();
  const img = imageDeps(deps);
  const r = new Hono();

  r.get('/api/capabilities', async (c) => c.json({ reveal: (await reveal.detect()) !== null }));

  r.post('/api/images/:imageId/reveal', sameOriginOnly, async (c) => {
    const id = normalizeId(c.req.param('imageId'));
    const target = id === null ? null : await locateImage(img, id);
    const out = await performReveal(target, reveal);
    return c.json(out.body, out.status);
  });

  return r;
}
```
**Impact:** New file; nothing imports it until Step 2. It depends on phase 2's `sameOrigin.ts` and its image-id `locateImage`.

### Step 2: Mount the router in the app
**File:** `src/http/app.ts`. Today the lines are 6 (`import { imageRoutes }`), 35–38 (`CreateAppOptions`), 40–43 (header comment) and 58 (`app.route('/', imageRoutes(deps));`). Phase 2 removes the local `LOOPBACK_HOSTNAMES` / `isLoopbackUrl` (lines 9–17) and adds an import from `./sameOrigin.js`, so these lines move up about 9 after phase 2. Place each edit by the anchor text quoted below.
**Change:** four hunks.

Hunk A: imports. Add after the line `import { imageRoutes } from './images.js';`:
```ts
import { revealRoutes, type RevealDeps } from './reveal.js';
```

Hunk B: replace the whole `CreateAppOptions` interface with:
```ts
export interface CreateAppOptions {
  /** The brain behind POST /api/chat. Omitted: apiRoutes' default (the stub). */
  chat?: ChatBackend;
  /** OS hooks behind /api/capabilities and the reveal route. Omitted: the real WSL detection and spawn. */
  reveal?: RevealDeps;
}
```

Hunk C: replace the `createApp` doc comment with:
```ts
/**
 * The whole HTTP surface, mounted in this order (later phases fill the routers, never this file):
 * /health, /mcp, apiRoutes (P6), imageRoutes (P5), revealRoutes (iteration 7: capabilities + reveal),
 * staticRoutes (P6, last: it owns the SPA fallback; it reserves /api, so the order is for clarity).
 */
```

Hunk D: in `createApp`, replace
```ts
  app.route('/', imageRoutes(deps));
  app.route('/', staticRoutes(deps));
```
with
```ts
  app.route('/', imageRoutes(deps));
  app.route('/', revealRoutes(deps, { reveal: options.reveal }));
  app.route('/', staticRoutes(deps));
```
After the four hunks, the end of `createApp` reads (whatever phase 2 did above the `/mcp` lines stays as phase 2 left it):
```ts
  app.route('/', apiRoutes(deps, { chat: options.chat }));
  app.route('/', imageRoutes(deps));
  app.route('/', revealRoutes(deps, { reveal: options.reveal }));
  app.route('/', staticRoutes(deps));
  return app;
}
```
**Impact:** `POST /api/images/:imageId/reveal` does not collide with phase 2/3 image routes: those are `GET /api/images/:imageId`, `GET /api/images/:imageId/{original|display|thumb|preview}`, `POST /api/images`, `POST /api/images/:imageId/restore` and `DELETE /api/images/:imageId`, and none of them is a `POST` with a `:param` in the last segment. `revealRoutes(deps, { reveal: undefined })` falls back to `defaultRevealDeps()`. Existing `createApp` callers compile unchanged.

### Step 3: Unit tests
**File:** `tests/unit/reveal.test.ts` (new)
**Change:** Pure tests with no database and no Explorer. The `runWslpath` tests run a temporary `/bin/sh` script as the "wslpath" binary to check the exact argv and the timeout. The `spawnDetached` tests use a fake `ChildProcess` (an `EventEmitter` with `unref`) for the spawn/error/no-exit rules, plus two real spawns of `process.execPath`: one that exits 1 (the exit code is ignored) and one of a missing binary (ENOENT → reject).
**Code:**
```ts
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
```
**Impact:** Adds about 30 unit tests to `npm test`. Two of them spawn `process.execPath`, two run `/bin/sh` scripts, and the timeout test takes about 200 ms; everything stays well under the 5 s unit timeout.

### Step 4: Integration tests
**File:** `tests/integration/reveal.int.test.ts` (new)
**Change:** Runs against the Docker Postgres through `startHarness()`. It covers two app setups:
- The **real** app (`h.app = createApp(deps)`, real `defaultRevealDeps`), used only for cases that can never spawn: the Origin 403s, the 404 for an unknown id (404s come before detect), and the capabilities shape (a boolean whose value depends on the machine). This proves the router is mounted ahead of the static fallback and that phase 2's guard is wired.
- An app built with `createApp(h.deps, { reveal: fake })` for capabilities true/false, the 409, the exact command line for a real uploaded image, the 500, and the not-on-this-machine 404 after the original is deleted.

Uploads go through `POST /api/images` (phase 2 wire: `note.images[0].id`).
**Code:**
```ts
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/http/app.js';
import type { RevealDeps, RevealEnv } from '../../src/http/reveal.js';
import { makeImage, startHarness, type Harness } from './imageHarness.js';

const ENV: RevealEnv = { explorer: '/mnt/c/Windows/explorer.exe', wslpath: '/usr/bin/wslpath' };
/** app.request() builds http://localhost/... URLs, so this is "our own page". */
const OWN_ORIGIN = 'http://localhost';

interface UploadResult {
  note: { id: string; images: Array<{ id: string; available: boolean; host: string | null }> };
  created: boolean;
}

/** Every member is a vi.fn mock (overrides are plain functions wrapped here), so .mock stays typed. */
function fakeReveal(over: { detect?: RevealDeps['detect']; spawn?: RevealDeps['spawn'] } = {}) {
  return {
    detect: vi.fn(over.detect ?? (async (): Promise<RevealEnv | null> => ENV)),
    wslpath: vi.fn(async (abs: string): Promise<string> => `\\\\wsl.localhost\\Ubuntu${abs.replaceAll('/', '\\')}`),
    spawn: vi.fn(over.spawn ?? (async (_cmd: string, _args: string[]): Promise<void> => undefined)),
  } satisfies RevealDeps;
}

describe('reveal in Explorer', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  async function uploadImage(rgb: { r: number; g: number; b: number }): Promise<string> {
    const png = await makeImage('png', 24, 16, rgb);
    const fd = new FormData();
    fd.append('file', new File([png], 'shot.png', { type: 'image/png' }));
    const res = await h.app.request('/api/images', { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    const { note } = (await res.json()) as UploadResult;
    expect(note.images).toHaveLength(1);
    return note.images[0]!.id;
  }

  function reveal(app: { request: typeof h.app.request }, imageId: string, origin?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (origin !== undefined) headers.Origin = origin;
    return Promise.resolve(app.request(`/api/images/${imageId}/reveal`, { method: 'POST', headers }));
  }

  describe('on the real app (never spawns)', () => {
    it('GET /api/capabilities answers { reveal: boolean }', async () => {
      const res = await h.app.request('/api/capabilities');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { reveal: unknown };
      expect(Object.keys(body)).toEqual(['reveal']);
      expect(typeof body.reveal).toBe('boolean');
    });

    it('403 forbidden_origin without an Origin header', async () => {
      const id = await uploadImage({ r: 10, g: 20, b: 30 });
      const res = await reveal(h.app, id);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden_origin' });
    });

    it('403 forbidden_origin for a foreign Origin, and for our host on another port', async () => {
      const id = await uploadImage({ r: 11, g: 21, b: 31 });
      for (const origin of ['http://evil.example', 'http://localhost:5173', 'null']) {
        const res = await reveal(h.app, id, origin);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'forbidden_origin' });
      }
    });

    it('404 not_found for an unknown or malformed image id (checked before detecting WSL)', async () => {
      for (const id of ['Z-ZZZ', 'not-an-id']) {
        const res = await reveal(h.app, id, OWN_ORIGIN);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'not_found' });
      }
    });

    it('GET on the reveal path is not served by the SPA fallback', async () => {
      const res = await h.app.request('/api/images/Z-ZZZ/reveal');
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type') ?? '').not.toMatch(/text\/html/);
    });
  });

  describe('with injected RevealDeps', () => {
    it('capabilities follow detect', async () => {
      const on = createApp(h.deps, { reveal: fakeReveal() });
      expect(await (await on.request('/api/capabilities')).json()).toEqual({ reveal: true });
      const off = createApp(h.deps, { reveal: fakeReveal({ detect: async () => null }) });
      expect(await (await off.request('/api/capabilities')).json()).toEqual({ reveal: false });
    });

    it('runs explorer.exe /select,<wslpath -w original> for a real image and answers 202', async () => {
      const id = await uploadImage({ r: 40, g: 50, b: 60 });
      const fake = fakeReveal();
      const app = createApp(h.deps, { reveal: fake });

      const res = await reveal(app, id.replace('-', '').toLowerCase(), OWN_ORIGIN);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true });

      expect(fake.wslpath).toHaveBeenCalledTimes(1);
      const abs = fake.wslpath.mock.calls[0]![0];
      expect(path.isAbsolute(abs)).toBe(true);
      expect(abs.startsWith(path.join(h.dataDir, 'images') + path.sep)).toBe(true);
      expect(abs).toMatch(new RegExp(`/images/\\d{4}/\\d{2}/${id}\\.png$`));

      expect(fake.spawn).toHaveBeenCalledTimes(1);
      expect(fake.spawn).toHaveBeenCalledWith(ENV.explorer, [`/select,\\\\wsl.localhost\\Ubuntu${abs.replaceAll('/', '\\')}`]);
    });

    it('409 reveal_unavailable when detect says no', async () => {
      const id = await uploadImage({ r: 70, g: 80, b: 90 });
      const fake = fakeReveal({ detect: async () => null });
      const res = await reveal(createApp(h.deps, { reveal: fake }), id, OWN_ORIGIN);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'reveal_unavailable' });
      expect(fake.spawn).not.toHaveBeenCalled();
    });

    it('500 spawn_failed when the spawn errors', async () => {
      const id = await uploadImage({ r: 100, g: 110, b: 120 });
      const fake = fakeReveal({
        spawn: async () => {
          throw new Error('spawn /mnt/c/Windows/explorer.exe EACCES');
        },
      });
      const res = await reveal(createApp(h.deps, { reveal: fake }), id, OWN_ORIGIN);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'spawn_failed', message: 'spawn /mnt/c/Windows/explorer.exe EACCES' });
    });

    it('404 not_on_this_machine (with host) once the original is gone, and nothing is spawned', async () => {
      const id = await uploadImage({ r: 130, g: 140, b: 150 });
      const fake = fakeReveal();
      const app = createApp(h.deps, { reveal: fake });
      expect((await reveal(app, id, OWN_ORIGIN)).status).toBe(202);
      const abs = fake.wslpath.mock.calls[0]![0];
      await rm(abs);
      fake.spawn.mockClear();

      const res = await reveal(app, id, OWN_ORIGIN);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string; host: string | null };
      expect(body.error).toBe('not_on_this_machine');
      expect('host' in body).toBe(true);
      expect(fake.spawn).not.toHaveBeenCalled();
    });

    it('still checks the Origin with injected deps', async () => {
      const id = await uploadImage({ r: 160, g: 170, b: 180 });
      const fake = fakeReveal();
      const res = await reveal(createApp(h.deps, { reveal: fake }), id, 'http://evil.example');
      expect(res.status).toBe(403);
      expect(fake.detect).not.toHaveBeenCalled();
      expect(fake.spawn).not.toHaveBeenCalled();
    });
  });
});
```
**Impact:** One more integration file, run serially with the others. It never starts Explorer: every case that could reach spawn uses the fake.

Note on the `'null'` Origin case: `new URL('null')` throws, and phase 2's guard treats that as 403 (confirmed: `isSameOrigin` wraps both `new URL` calls in `try`/`catch` and returns false; phase-2.md Step 7). Should an implementation ever let the throw escape as a 500, this assertion catches it, and the fix belongs in `sameOrigin.ts` (phase 2), not here.

Note on the "GET on the reveal path" case: phase 2 serves `GET /api/images/:imageId/:variant` for the four variant names only. `reveal` is not a variant, so the request falls through to `staticRoutes`, which returns `c.notFound()` for reserved `/api` paths (`src/http/static.ts:89`). If phase 2 registered a catch-all `:variant` that answers its own 404 JSON, the assertion still holds: it only checks the status is 404 and the body is not HTML.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npx vitest run tests/unit/reveal.test.ts`, then `npm test` and `npm run test:int` (the latter needs the Docker DBs that `scripts/test-int.sh` starts)
**Manual check (optional, on this WSL laptop, after phase 2 and with a dev daemon):** `curl -s localhost:7317/api/capabilities` → `{"reveal":true}`; `curl -si -X POST -H 'Origin: http://localhost:7317' localhost:7317/api/images/<imageId>/reveal` → `202`, and Explorer opens with the file selected; the same call without `-H Origin` → `403`.
**Exit criteria:** `GET /api/capabilities` reports `reveal: false` when detect finds no WSL (unit: non-linux / no interop / no wslpath / no explorer; integration: injected). The reveal route answers 202 as soon as the child spawns, with no `exit`/`close` listener ever attached (unit `spawnDetached` test). The command line is exactly `[explorer, ['/select,' + wslpath -w original]]` (unit + integration). Origin 403s, 404 `not_found` / `not_on_this_machine`, 409 and 500 are all covered. `npm run typecheck`, `npm test` and `npm run test:int` are green.

## Handoffs

- **Phase 9 (R4 web half):** consumes `GET /api/capabilities` → `{ reveal: boolean }` and `POST /api/images/:imageId/reveal`. The browser sends `Origin` on same-origin `fetch` POSTs, so a plain `fetch(url, { method: 'POST' })` passes. Expect 202 `{ ok: true }`; the button should treat 404/409/500 as a quiet failure (the bodies are listed in the Interface Contract). Vite dev server (reconciled, no change to `web/vite.config.ts`): its proxy entries have no `changeOrigin`, so the proxied request keeps `Host: 127.0.0.1:5173` (or `localhost:5173`). notesd then sees a request URL of `http://127.0.0.1:5173/...` and an `Origin` of `http://127.0.0.1:5173`: same origin, loopback, so `sameOriginOnly` lets it through. Adding `changeOrigin: true` would break that (Host would become `127.0.0.1:7317` while Origin stays `:5173`), so nobody should add it.
- **Phase 10 (R5 docs):** README API table gains `GET /api/capabilities` and `POST /api/images/:imageId/reveal` (own Origin only, 202/403/404/409/500). Document the `NOTESD_EXPLORER_BIN` override and the resolution order: `NOTESD_EXPLORER_BIN`, then `explorer.exe` on PATH, then `/mnt/c/Windows/explorer.exe`. A set but wrong override disables reveal, with no fallback. No `deploy/notesd.service` change is needed.
- **Phase 2 (reconciled):** this phase depends on `sameOriginOnly` answering 403, not throwing, for an unparseable `Origin` such as `null`; phase 2's code does. The integration test asserts it.
- None of this phase's steps serves R1, R2, R3, R6 or R7.

## Rollback

Delete `src/http/reveal.ts`, `tests/unit/reveal.test.ts` and `tests/integration/reveal.int.test.ts`, and revert the four hunks in `src/http/app.ts`: the import, `CreateAppOptions.reveal`, the comment and the `revealRoutes` mount. Equivalently, `git revert` the phase commit. No schema, config or data changes to undo. Phase 9's button stays hidden, because a missing `/api/capabilities` should read as `reveal: false` (phase 9's own fallback).
