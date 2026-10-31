import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';
import { fileDeps, locateFile } from '../files/ingest.js';
import { filesDirFor } from '../files/store.js';
import { imageDeps, locateImage, type ImageDeps } from '../images/ingest.js';
import { normalizeId } from '../notes/ids.js';
import type { Note } from '../notes/types.js';
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

/** 'select': Explorer opens the parent folder with the file selected. 'open': Explorer opens the folder itself. */
export type RevealMode = 'select' | 'open';

/** explorer.exe's arguments: one `/select,<path>` argument (no space after the comma), or the folder path alone. */
export function explorerArgs(winPath: string, mode: RevealMode = 'select'): string[] {
  return mode === 'select' ? ['/select,' + winPath] : [winPath];
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

/** What the reveal needs (LocatedImage, LocatedFile and a note's files folder satisfy it). */
export interface RevealTarget {
  /** Absolute path under this machine's data dir: the file to select, or the folder to open. */
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
export async function performReveal(
  target: RevealTarget | null,
  reveal: RevealDeps,
  mode: RevealMode = 'select',
): Promise<RevealOutcome> {
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
    await reveal.spawn(env.explorer, explorerArgs(winPath, mode));
  } catch (err) {
    return { status: 500, body: { error: 'spawn_failed', message: errorMessage(err) } };
  }
  return { status: 202, body: { ok: true } };
}

/** What a note-level reveal does: a target (null = 404 not_found) and how Explorer shows it. */
export interface NoteRevealPlan {
  target: RevealTarget | null;
  mode: RevealMode;
}

/**
 * Note-level "Show in Explorer". A missing or deleted note: not_found. A note with live files:
 * open `files/<noteId>/` (available when at least one of its live files is on this machine;
 * otherwise not_on_this_machine with the first file's host). No live files: select the first live
 * image, as the card button always did. Neither: not_found.
 */
export async function noteRevealPlan(
  dataDir: string,
  img: Pick<ImageDeps, 'dataDir' | 'records'>,
  note: Note | null,
): Promise<NoteRevealPlan> {
  if (note === null || note.deleted_at !== undefined) return { target: null, mode: 'select' };
  const firstFile = note.files[0];
  if (firstFile !== undefined) {
    return {
      mode: 'open',
      target: {
        originalPath: filesDirFor(dataDir, note.id),
        available: note.files.some((f) => f.available),
        host: firstFile.host,
      },
    };
  }
  const firstImage = note.images[0];
  if (firstImage === undefined) return { target: null, mode: 'select' };
  return { mode: 'select', target: await locateImage(img, firstImage.id) };
}

/**
 * GET /api/capabilities -> { reveal }.
 * POST /api/images/:imageId/reveal (own Origin only) -> Explorer with the image's original selected.
 * POST /api/files/:fileId/reveal (own Origin only) -> Explorer with the file selected.
 * POST /api/notes/:id/reveal (own Origin only) -> the note's files folder, or its first image (noteRevealPlan).
 * Every route takes an id, never a path.
 */
export function revealRoutes(deps: AppDeps, opts: RevealRoutesOptions = {}): Hono {
  const reveal = opts.reveal ?? defaultRevealDeps();
  const img = imageDeps(deps);
  const files = fileDeps(deps);
  const r = new Hono();

  r.get('/api/capabilities', async (c) => c.json({ reveal: (await reveal.detect()) !== null }));

  r.post('/api/images/:imageId/reveal', sameOriginOnly, async (c) => {
    const id = normalizeId(c.req.param('imageId'));
    const target = id === null ? null : await locateImage(img, id);
    const out = await performReveal(target, reveal);
    return c.json(out.body, out.status);
  });

  r.post('/api/files/:fileId/reveal', sameOriginOnly, async (c) => {
    const id = normalizeId(c.req.param('fileId'));
    const target = id === null ? null : await locateFile(files, id);
    const out = await performReveal(target, reveal, 'select');
    return c.json(out.body, out.status);
  });

  r.post('/api/notes/:id/reveal', sameOriginOnly, async (c) => {
    const id = normalizeId(c.req.param('id'));
    const note = id === null ? null : await deps.service.getOne(id);
    const plan = await noteRevealPlan(deps.config.dataDir, img, note);
    const out = await performReveal(plan.target, reveal, plan.mode);
    return c.json(out.body, out.status);
  });

  return r;
}
