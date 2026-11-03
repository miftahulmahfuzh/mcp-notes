import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Web links for the commits a session made (`cc_sessions.commits` holds the short sha that
 * `git commit` printed). The repo's `origin` remote gives the forge: github.com links
 * `<base>/commit/<sha>`, bitbucket.org `<base>/commits/<sha>`, and any other host is taken for
 * GitLab (self-hosted, e.g. git.tuntun.co.id) and links `<base>/-/commit/<sha>`. The short sha is
 * widened to the full one when the commit is in the local clone. Everything is read from a clone on
 * this machine (the session's cwd, else `~/<repo>`); without one the commits carry no link.
 *
 * A session often commits in a repo other than the one it started in (`cd ~/other && git commit`),
 * so each sha is looked up in the session's own clone first and then in the other clones directly
 * under the home folder, and linked to the first clone that holds it as a commit. A sha no clone
 * knows still links through the session's own clone, as before.
 */

export type ForgeKind = 'github' | 'gitlab' | 'bitbucket';

export interface RepoWeb {
  /** `https://host/owner/repo`, no `.git`, no trailing slash. */
  base: string;
  kind: ForgeKind;
}

/** `git@host:a/b(.git)`, `ssh://git@host[:port]/a/b(.git)`, `https://[user@]host/a/b(.git)` -> the web base; null otherwise. */
export function webFromRemote(remote: string): RepoWeb | null {
  const r = remote.trim();
  let host: string;
  let repoPath: string;
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(r);
  if (scp !== null && !r.includes('://')) {
    host = scp[1] ?? '';
    repoPath = scp[2] ?? '';
  } else {
    let u: URL;
    try {
      u = new URL(r);
    } catch {
      return null;
    }
    if (!['https:', 'http:', 'ssh:', 'git+ssh:'].includes(u.protocol)) return null;
    host = u.hostname;
    repoPath = u.pathname;
  }
  repoPath = repoPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  if (host === '' || repoPath === '' || !/^[\w.~-]+(\/[\w.~-]+)+$/.test(repoPath)) return null;
  const lower = host.toLowerCase();
  const kind: ForgeKind = lower === 'github.com' ? 'github' : lower === 'bitbucket.org' ? 'bitbucket' : 'gitlab';
  return { base: `https://${lower}/${repoPath}`, kind };
}

export function commitUrl(web: RepoWeb, sha: string): string {
  const segment = web.kind === 'github' ? 'commit' : web.kind === 'bitbucket' ? 'commits' : '-/commit';
  return `${web.base}/${segment}/${sha}`;
}

/** Runs git in `dir` (stdin optional); stdout, or null on any failure. */
export type GitRunner = (dir: string, args: readonly string[], input?: string) => Promise<string | null>;

/** sha as stored -> commit URL, for the shas that could be linked. Never throws. */
export type CommitLinker = (args: { repo: string | null; cwd: string | null; shas: readonly string[] }) => Promise<Map<string, string>>;

const GIT_TIMEOUT_MS = 3_000;
/** How long a repo's remote lookup is reused: found, and not found (a clone may appear later). */
const FOUND_TTL_MS = 10 * 60_000;
const MISSING_TTL_MS = 60_000;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHORT_SHA = /^[0-9a-f]{4,40}$/;

const runGit: GitRunner = (dir, args, input) =>
  new Promise((resolve) => {
    const child = execFile('git', ['-C', dir, ...args], { timeout: GIT_TIMEOUT_MS, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
    if (input !== undefined) child.stdin?.end(input);
  });

/** Directories directly under `homeDir` that hold a git checkout (`.git` file or folder). */
async function listHomeClones(homeDir: string): Promise<string[]> {
  try {
    const names = await readdir(homeDir);
    const dirs: string[] = [];
    await Promise.all(
      names
        .filter((n) => !n.startsWith('.'))
        .map(async (n) => {
          const dir = path.join(homeDir, n);
          try {
            await stat(path.join(dir, '.git'));
            dirs.push(dir);
          } catch {
            // Not a checkout.
          }
        }),
    );
    return dirs.sort();
  } catch {
    return [];
  }
}

export function createCommitLinker(options: {
  homeDir: string;
  git?: GitRunner;
  now?: () => number;
  /** Clones to search after the session's own. Default: the git checkouts directly under `homeDir`. */
  siblings?: () => Promise<string[]>;
}): CommitLinker {
  const git = options.git ?? runGit;
  const now = options.now ?? Date.now;
  const listSiblings = options.siblings ?? (() => listHomeClones(options.homeDir));
  const repos = new Map<string, { at: number; found: { dir: string; web: RepoWeb } | null }>();
  let siblingCache: { at: number; clones: { dir: string; web: RepoWeb }[] } | null = null;
  /** `${dir}\0${short}` -> full sha. */
  const fullShas = new Map<string, string>();

  const webOf = async (dir: string): Promise<RepoWeb | null> => {
    const remote = await git(dir, ['remote', 'get-url', 'origin']);
    return remote === null ? null : webFromRemote(remote);
  };

  const locate = async (repo: string | null, cwd: string | null): Promise<{ dir: string; web: RepoWeb } | null> => {
    const key = repo ?? `cwd:${cwd ?? ''}`;
    const cached = repos.get(key);
    if (cached !== undefined && now() - cached.at < (cached.found !== null ? FOUND_TTL_MS : MISSING_TTL_MS)) return cached.found;
    const dirs = [cwd, repo !== null && repo !== '~' && !repo.includes('/') ? path.join(options.homeDir, repo) : null];
    let found: { dir: string; web: RepoWeb } | null = null;
    for (const dir of dirs) {
      if (dir === null || dir.trim() === '') continue;
      const web = await webOf(dir);
      if (web !== null) {
        found = { dir, web };
        break;
      }
    }
    repos.set(key, { at: now(), found });
    return found;
  };

  const siblingClones = async (): Promise<{ dir: string; web: RepoWeb }[]> => {
    if (siblingCache !== null && now() - siblingCache.at < FOUND_TTL_MS) return siblingCache.clones;
    const clones: { dir: string; web: RepoWeb }[] = [];
    for (const dir of await listSiblings()) {
      const web = await webOf(dir);
      if (web !== null) clones.push({ dir, web });
    }
    siblingCache = { at: now(), clones };
    return clones;
  };

  /** Resolves each sha to its full form where `dir` holds it as a commit, one `git cat-file --batch-check` for the ones not seen yet. */
  const widen = async (dir: string, shas: readonly string[]): Promise<void> => {
    const ask = shas.filter((s) => !fullShas.has(`${dir}\0${s}`));
    if (ask.length === 0) return;
    const out = await git(dir, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], `${ask.join('\n')}\n`);
    if (out === null) return;
    const lines = out.split('\n');
    ask.forEach((short, i) => {
      const [full, type] = (lines[i] ?? '').split(' ');
      if (full !== undefined && FULL_SHA.test(full) && type === 'commit' && full.startsWith(short)) fullShas.set(`${dir}\0${short}`, full);
    });
  };

  return async ({ repo, cwd, shas }) => {
    const out = new Map<string, string>();
    const wanted = [...new Set(shas.map((s) => s.toLowerCase()).filter((s) => SHORT_SHA.test(s)))];
    if (wanted.length === 0) return out;
    try {
      const primary = await locate(repo, cwd);
      let remaining = wanted;
      /** Links the shas of `remaining` that `clone` holds as commits. */
      const tryClone = async (clone: { dir: string; web: RepoWeb }): Promise<void> => {
        await widen(clone.dir, remaining);
        const left: string[] = [];
        for (const sha of remaining) {
          const full = fullShas.get(`${clone.dir}\0${sha}`);
          if (full !== undefined) out.set(sha, commitUrl(clone.web, full));
          else left.push(sha);
        }
        remaining = left;
      };
      // The session's own clone answers first; the others are only opened for shas it does not hold.
      if (primary !== null) await tryClone(primary);
      if (remaining.length > 0) {
        for (const clone of await siblingClones()) {
          if (remaining.length === 0) break;
          if (clone.dir !== primary?.dir) await tryClone(clone);
        }
      }
      // No clone holds these (pruned, or a machine without the repo): link through the session's own clone.
      if (primary !== null) for (const sha of remaining) out.set(sha, commitUrl(primary.web, sha));
    } catch {
      // No links rather than no detail.
    }
    return out;
  };
}
