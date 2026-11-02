import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';

/**
 * The "unfinished" badge (R9). A node named `orch-<slug>` is the coordinator of a swarm plan
 * set; its ledger lives at `<main checkout>/.workflows/orchestration/<slug>/ledger.json`.
 * `swarm.py verify --slug <slug>`, run with the repo as cwd, re-derives each phase's status from
 * git and todos.md and prints JSON (it always exits 0; a missing ledger is `{"swarm": false}`).
 *
 * unfinished = some phase is not derived `done` AND the orch session is not live.
 *
 * Measured 2026-11-02: verify takes 0.04-0.11 s per slug. A graph can hold dozens of orch
 * nodes, so answers are cached per (dir, slug) for `ttlMs`, refreshed stale-while-revalidate,
 * run at most `concurrency` at a time, and a request waits at most `waitMs` for answers it has
 * never seen. Everything else reports null (unknown) and fills in on the next fetch.
 */

export const ORCH_PREFIX = 'orch-';
export const UNFINISHED_TTL_MS = 60_000;
export const UNFINISHED_WAIT_MS = 1_000;
export const SWARM_TIMEOUT_MS = 10_000;
export const SWARM_CONCURRENCY = 4;

/** swarm.py's slugify alphabet (`[A-Za-z0-9._-]`, max 60). Anything else is not a ledger slug. */
const SLUG_PATTERN = /^[A-Za-z0-9._-]{1,60}$/;
/** A repo key used as a directory name under $HOME; never a path with separators. */
const REPO_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface SwarmRunRequest {
  /** Absolute path to swarm.py. */
  script: string;
  slug: string;
  /** Directory swarm.py resolves the repo from (it walks to the main checkout itself). */
  cwd: string;
  timeoutMs: number;
}

export interface SwarmRunResult {
  /** Exit code; null when the process could not start, was killed, or timed out. */
  code: number | null;
  stdout: string;
}

/** Runs `swarm.py verify`. Tests inject a fake; the daemon uses `defaultSwarmRunner`. */
export type SwarmRunner = (req: SwarmRunRequest) => Promise<SwarmRunResult>;

/** `python3 <script> verify --slug <slug>` in `cwd`. Read-only: never passes `--apply`. Never rejects. */
export const defaultSwarmRunner: SwarmRunner = (req) =>
  new Promise((resolve) => {
    execFile(
      'python3',
      [req.script, 'verify', '--slug', req.slug],
      { cwd: req.cwd, timeout: req.timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          const code = typeof error.code === 'number' ? error.code : null;
          resolve({ code, stdout: typeof stdout === 'string' ? stdout : '' });
          return;
        }
        resolve({ code: 0, stdout });
      },
    );
  });

/** `orch-wall-editing` -> `wall-editing`; anything that is not an orch name -> null. */
export function orchSlug(name: string | null | undefined): string | null {
  if (!name || !name.startsWith(ORCH_PREFIX)) return null;
  const slug = name.slice(ORCH_PREFIX.length);
  return SLUG_PATTERN.test(slug) ? slug : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * true: the ledger has a phase whose derived status (or, without one, its ledger status) is not
 * `done` -- pending, spawned, running, failed or blocked all mean the set is not finished.
 * false: every phase is done, the ledger has no phases, or the repo has no ledger for the slug
 * (`{"swarm": false, "repo": ...}`).
 * null: anything else (not JSON, swarm.py could not find a repo, an unknown shape).
 */
export function parseVerifyOutput(stdout: string): boolean | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  if (data.swarm === false) {
    // "no ledger for X" carries the repo it looked in; "not inside a git repository" does not.
    return typeof data.repo === 'string' ? false : null;
  }
  if (data.swarm !== true || !Array.isArray(data.phases)) return null;
  return data.phases.some((phase) => {
    if (!isRecord(phase)) return false;
    const derived = typeof phase.derived === 'string' ? phase.derived : null;
    const status = typeof phase.status === 'string' ? phase.status : null;
    const effective = derived ?? status;
    return effective !== null && effective !== 'done';
  });
}

/** The fields of a graph/detail node this module reads and writes. */
export interface UnfinishedTarget {
  name: string | null;
  custom_title?: string | null;
  host: string;
  cwd: string | null;
  repo: string | null;
  live: boolean;
  unfinished: boolean | null;
}

export interface UnfinishedCheckerOptions {
  /** `config.sessions.swarmScript`. Null, or a path with no file behind it: every orch node is null. */
  swarmScript: string | null;
  /** This machine. Default `os.hostname()`, the same value ingest writes into `cc_sessions.host`. */
  host?: string;
  /** Fallback repo checkout is `<homeDir>/<repo>`. Default `os.homedir()`. */
  homeDir?: string;
  runner?: SwarmRunner;
  exists?: (p: string) => boolean;
  now?: () => number;
  ttlMs?: number;
  waitMs?: number;
  timeoutMs?: number;
  concurrency?: number;
}

export interface UnfinishedChecker {
  /**
   * Sets `unfinished` on every orch node of `nodes` (in place) and returns the same array.
   * Non-orch nodes are left as they are (null). Never throws.
   */
  annotate<T extends UnfinishedTarget>(nodes: T[]): Promise<T[]>;
}

interface CacheEntry {
  value: boolean | null;
  at: number;
}

interface LedgerRef {
  key: string;
  slug: string;
  cwd: string;
}

export function createUnfinishedChecker(options: UnfinishedCheckerOptions): UnfinishedChecker {
  const host = options.host ?? hostname();
  const homeDir = options.homeDir ?? homedir();
  const runner = options.runner ?? defaultSwarmRunner;
  const exists = options.exists ?? existsSync;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? UNFINISHED_TTL_MS;
  const waitMs = options.waitMs ?? UNFINISHED_WAIT_MS;
  const timeoutMs = options.timeoutMs ?? SWARM_TIMEOUT_MS;
  const concurrency = Math.max(1, options.concurrency ?? SWARM_CONCURRENCY);

  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<boolean | null>>();
  const queue: Array<() => void> = [];
  let running = 0;

  async function withSlot<R>(fn: () => Promise<R>): Promise<R> {
    if (running >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    running += 1;
    try {
      return await fn();
    } finally {
      running -= 1;
      queue.shift()?.();
    }
  }

  function candidateDirs(node: UnfinishedTarget): string[] {
    const dirs: string[] = [];
    if (node.cwd && path.isAbsolute(node.cwd)) dirs.push(node.cwd);
    // The orch session's cwd is the set's worktree, usually deleted after landing; the ledger
    // lives in the main checkout, which by the user's convention is ~/<repo>.
    if (node.repo && REPO_KEY_PATTERN.test(node.repo)) dirs.push(path.join(homeDir, node.repo));
    return dirs;
  }

  function ledgerRef(node: UnfinishedTarget): LedgerRef | null {
    const slug = orchSlug(node.name) ?? orchSlug(node.custom_title ?? null);
    if (!slug) return null;
    const cwd = candidateDirs(node).find((dir) => exists(dir));
    if (!cwd) return null;
    return { key: `${cwd}\u0000${slug}`, slug, cwd };
  }

  function refresh(ref: LedgerRef, script: string): Promise<boolean | null> {
    const pending = inflight.get(ref.key);
    if (pending) return pending;
    const run = withSlot(async () => {
      let value: boolean | null = null;
      try {
        const result = await runner({ script, slug: ref.slug, cwd: ref.cwd, timeoutMs });
        value = result.code === 0 ? parseVerifyOutput(result.stdout) : null;
      } catch {
        value = null;
      }
      cache.set(ref.key, { value, at: now() });
      return value;
    }).finally(() => {
      inflight.delete(ref.key);
    });
    inflight.set(ref.key, run);
    return run;
  }

  async function waitAtMost(promises: Promise<unknown>[], ms: number): Promise<void> {
    if (promises.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
    try {
      await Promise.race([Promise.all(promises).then(() => undefined), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    async annotate<T extends UnfinishedTarget>(nodes: T[]): Promise<T[]> {
      const orch = nodes.filter((n) => orchSlug(n.name) !== null || orchSlug(n.custom_title ?? null) !== null);
      if (orch.length === 0) return nodes;

      const script = options.swarmScript;
      if (script === null || !exists(script)) {
        for (const node of orch) node.unfinished = null;
        return nodes;
      }

      const refs = new Map<T, LedgerRef>();
      // Values already cached are answered as they were when this call started, so a stale entry
      // is served at once even if its refresh happens to finish before the first-time wait ends.
      const cached = new Map<string, boolean | null>();
      const firstTime: Promise<boolean | null>[] = [];
      for (const node of orch) {
        // Owning host only: the other machine's cwd means nothing here, and its daemon answers for it.
        if (node.host !== host) continue;
        const ref = ledgerRef(node);
        if (!ref) continue;
        refs.set(node, ref);
        const hit = cache.get(ref.key);
        if (hit) cached.set(ref.key, hit.value);
        if (hit && now() - hit.at < ttlMs) continue;
        const run = refresh(ref, script);
        if (!hit) firstTime.push(run);
      }

      await waitAtMost(firstTime, waitMs);

      for (const node of orch) {
        const ref = refs.get(node);
        const pending = !ref ? null : cached.has(ref.key) ? cached.get(ref.key)! : (cache.get(ref.key)?.value ?? null);
        node.unfinished = pending === null ? null : pending && !node.live;
      }
      return nodes;
    },
  };
}
