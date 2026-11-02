import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Which repository a Claude Code session belongs to, as a short key (`mcp-notes`,
 * `agentic_golang`). Measured 2026-11-02: 126 of 166 project dirs are worktree sessions whose
 * directory is usually deleted after landing, so the path conventions come first and need no disk:
 *
 * 1. `<worktreesDir>/<repo>/<slug>[/...]` (swarm and /analyze worktrees)       -> `<repo>`
 * 2. `<root>/.claude/worktrees/<slug>[/...]` (Claude Code's own worktrees)        -> basename(`<root>`)
 * 3. the home dir itself                                                           -> `~`
 * 4. an existing directory inside a git repo: the main checkout's directory name
 *    (`--git-common-dir`, so a linked worktree resolves to its repo, not its slug)
 * 5. a path under home: its first segment (`~/agentic/docs/plans` -> `agentic`; repos live at `~/<repo>`)
 * 6. anything else: the cwd's basename
 *
 * Without a cwd (no record carried one; never seen on this machine) the project dir name is
 * decoded instead. That encoding replaces every non-alphanumeric character with `-`, so it is
 * lossy (`agentic_golang` -> `agentic-golang`); it is matched against the directory names that
 * exist under home and the worktrees dir, longest first.
 */

export interface GitRoots {
  /** `git rev-parse --show-toplevel`. */
  toplevel: string;
  /** `git rev-parse --git-common-dir`, absolute. `<main checkout>/.git` for a linked worktree too. */
  commonDir: string;
}

export interface RepoResolverOptions {
  homeDir: string;
  worktreesDir: string;
  /** Default: `fs.stat(p).isDirectory()`. */
  isDirectory?: (p: string) => Promise<boolean>;
  /** Default: `gitRepoRoots` (runs git). Tests inject a fake. */
  gitRoots?: (cwd: string) => Promise<GitRoots | null>;
  /** Directory names that may be repo keys, for decoding project dir names. Default: entries of homeDir and worktreesDir. */
  listRepoNames?: () => Promise<string[]>;
}

export interface RepoResolver {
  /** The repo key for a session, or null when there is nothing to go on. Results are cached per cwd. */
  resolve(cwd: string | null, projectDirName: string): Promise<string | null>;
}

/** Claude Code's project dir name for a cwd: every character outside [a-zA-Z0-9] becomes `-`. */
export function encodeProjectDir(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

function isInside(child: string, parent: string): string | null {
  const rel = path.relative(parent, child);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

/** Rule 1: `<worktreesDir>/<repo>/...` -> `<repo>`. */
export function repoFromWorktreePath(cwd: string, worktreesDir: string): string | null {
  const rel = isInside(path.resolve(cwd), path.resolve(worktreesDir));
  if (rel === null) return null;
  const first = rel.split(path.sep)[0];
  return first === undefined || first === '' ? null : first;
}

/** Rule 2: `<root>/.claude/worktrees/<slug>/...` -> basename(`<root>`). */
export function repoFromClaudeWorktree(cwd: string): string | null {
  const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
  const at = path.resolve(cwd).indexOf(marker);
  if (at <= 0) return null;
  const root = path.resolve(cwd).slice(0, at);
  const name = path.basename(root);
  return name === '' ? null : name;
}

/** The repo key from git roots: the main checkout's directory name. */
export function repoFromGitRoots(roots: GitRoots): string {
  const common = path.resolve(roots.commonDir);
  if (path.basename(common) === '.git') return path.basename(path.dirname(common));
  return path.basename(path.resolve(roots.toplevel));
}

/** Rules 3, 5 and 6 (no disk): `~`, the first segment under home, else the basename. */
export function repoFromPath(cwd: string, homeDir: string): string | null {
  const abs = path.resolve(cwd);
  const home = path.resolve(homeDir);
  if (abs === home) return '~';
  const rel = isInside(abs, home);
  if (rel !== null) {
    const first = rel.split(path.sep)[0];
    if (first !== undefined && first !== '') return first;
  }
  const base = path.basename(abs);
  return base === '' ? null : base;
}

/**
 * The repo key from a project dir name alone (`-home-u--worktrees-mcp-notes-wall-editing`).
 * `knownNames` are real directory names; the longest whose encoding prefixes the rest wins.
 */
export function repoFromProjectDir(name: string, homeDir: string, worktreesDir: string, knownNames: string[]): string | null {
  const byLength = [...new Set(knownNames)].sort((a, b) => b.length - a.length);
  const match = (rest: string): string => {
    for (const known of byLength) {
      const enc = encodeProjectDir(known);
      if (rest === enc || rest.startsWith(`${enc}-`)) return known;
    }
    const first = rest.split('-').find((part) => part !== '');
    return first ?? rest;
  };
  const wt = `${encodeProjectDir(path.resolve(worktreesDir))}-`;
  if (name.startsWith(wt) && name.length > wt.length) return match(name.slice(wt.length));
  const home = encodeProjectDir(path.resolve(homeDir));
  if (name === home) return '~';
  if (name.startsWith(`${home}-`) && name.length > home.length + 1) return match(name.slice(home.length + 1));
  return null;
}

/** `git rev-parse` in `cwd`; null when it is not a git directory or git fails. */
export async function gitRepoRoots(cwd: string): Promise<GitRoots | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      { timeout: 3_000, windowsHide: true },
    );
    const [toplevel, commonDir] = stdout.split('\n').map((line) => line.trim());
    if (!toplevel || !commonDir) return null;
    return { toplevel, commonDir };
  } catch {
    return null;
  }
}

async function isDirectoryOnDisk(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function listDirNames(dirs: string[]): Promise<string[]> {
  const names: string[] = [];
  for (const dir of dirs) {
    try {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) names.push(entry.name);
      }
    } catch {
      // A missing dir contributes nothing.
    }
  }
  return names;
}

export function createRepoResolver(options: RepoResolverOptions): RepoResolver {
  const isDirectory = options.isDirectory ?? isDirectoryOnDisk;
  const gitRoots = options.gitRoots ?? gitRepoRoots;
  const listRepoNames = options.listRepoNames ?? (() => listDirNames([options.homeDir, options.worktreesDir]));
  const byCwd = new Map<string, Promise<string | null>>();
  let known: Promise<string[]> | null = null;

  const fromCwd = async (cwd: string): Promise<string | null> => {
    const conventional = repoFromWorktreePath(cwd, options.worktreesDir) ?? repoFromClaudeWorktree(cwd);
    if (conventional !== null) return conventional;
    if (path.resolve(cwd) === path.resolve(options.homeDir)) return '~';
    if (await isDirectory(cwd)) {
      const roots = await gitRoots(cwd);
      if (roots !== null) {
        const viaGit = repoFromWorktreePath(roots.toplevel, options.worktreesDir);
        return viaGit ?? repoFromGitRoots(roots);
      }
    }
    return repoFromPath(cwd, options.homeDir);
  };

  return {
    async resolve(cwd, projectDirName) {
      if (cwd !== null && cwd.trim() !== '') {
        const key = path.resolve(cwd);
        let hit = byCwd.get(key);
        if (hit === undefined) {
          hit = fromCwd(key);
          byCwd.set(key, hit);
        }
        return hit;
      }
      known ??= listRepoNames();
      return repoFromProjectDir(projectDirName, options.homeDir, options.worktreesDir, await known);
    },
  };
}
