> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/project-session-graph/PLAN.md` phase 13. Source: `.workflows/plan/project-session-graph/phase-13.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 13: "unfinished" badge for orch nodes

**Plan set:** `PROJECT_SESSION_GRAPH_PLAN.md`
**Analysis:** `docs/analyzer/20261102-093105-N9JN_code_analyzer.md`
**Satisfies:** R9: an orch node whose swarm ledger still has pending phases and no live session shows "unfinished"
**Depends on:** Phase 12 (and, through it, 1, 3, 7, 9, 10, 11)
**Difficulty:** NORMAL
**Package:** `src/sessions` (+ `src/http`, `web/src/components/graph`)

---

## Goal

`GET /api/projects/:repo/sessions` and `GET /api/sessions/:nodeId` fill the reserved
`unfinished` field. It is `true` for a node named `orch-<slug>` that lives on this host, has no
live session, and whose swarm ledger for `<slug>` still has phases not derived `done`. It is
`false` for an orch node whose ledger is finished, missing, or whose session is live, and `null`
when the answer is unknown (other host, script missing, swarm.py failed or slow, not an orch
node). The graph node and the node panel header show an "unfinished" badge only when the value
is `true`. A missing swarm script turns the feature off without an error.

## Facts measured for this plan (2026-11-02, Lenovo)

- `swarm.py verify --slug SLUG` (`~/claude-commands/skills/swarm/swarm.py:1062`) is read-only
  without `--apply`. It has no `--json` flag because **every** subcommand prints JSON (indent 2) on
  stdout and **always exits 0** (`soft()` at `:103`). Only an argparse error (bad invocation) exits 2.
- It finds the ledger from **cwd**, not from an argument: `find_repo_and_slug` -> `main_worktree(cwd)`
  (`:168`) runs `git rev-parse --git-common-dir`, so a cwd inside a linked worktree resolves to
  the main checkout, and the ledger is `<main checkout>/.workflows/orchestration/<slug>/ledger.json`
  (`durable_path`, `:268`).
- Outputs:
  - ledger found: `{"swarm": true, "slug", "disagreements", "applied", "runnable_now", "stalled",
    "phases": [{"n","title","status","derived","commit","task_id"}]}`. `derived` is git's
    derivation (`verify()` `:407`) and wins over `status`; statuses are
    `pending|spawned|running|done|failed|blocked`.
  - no ledger in a repo: `{"swarm": false, "reason": "no ledger for X", "repo": "/home/.../mcp-notes"}`.
  - cwd not in a git repo: `{"swarm": false, "reason": "not inside a git repository"}` (no `repo` key).
- Runtime: 0.11 s for `wall-editing` (11 phases, all done, each with commit + task_id), 0.08 s for
  `connectors`, 0.04 s for a missing ledger or a non-repo cwd. It is one `git` call per commit and
  one `git grep` per TaskID, so a 14-phase set stays well under 0.5 s.
- `status --slug` prints the same `phases[].status` but no `derived`, so it trusts a ledger that
  may say `running` forever. `verify` is the one to use (as the brief says).
- The coordinator session is named `orch-<slug>` (`SKILL.md:236`, `swarm.py launch --name orch-<slug>`).
  The orch session's cwd is the set's worktree (`~/.worktrees/<repo>/<slug>`), which is normally
  deleted after landing, so a fallback directory is needed (Step 2, `candidateDirs`).

Consequence for the design: a graph with 30 orch nodes costs ~3 s of python if run serially on
every request. So results are cached per `(dir, slug)` for 60 s, refreshed
stale-while-revalidate, run at most 4 at a time, and the request waits at most 1 s for
first-time answers. Anything not ready in time reports `null` and fills in on the next fetch
(the wall re-polls the graph every 10 s with If-None-Match; there is no SSE event for sessions).

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `src/sessions/unfinished.ts`: `ORCH_PREFIX`, `UNFINISHED_TTL_MS`, `UNFINISHED_WAIT_MS`,
  `SWARM_TIMEOUT_MS`, `SWARM_CONCURRENCY`, types `SwarmRunRequest`, `SwarmRunResult`,
  `SwarmRunner`, `UnfinishedTarget`, `UnfinishedCheckerOptions`, `UnfinishedChecker`, functions
  `defaultSwarmRunner`, `orchSlug`, `parseVerifyOutput`, `createUnfinishedChecker`.
- `src/config.ts`: field `SessionsConfig.swarmScript: string | null`, constant
  `DEFAULT_SWARM_SCRIPT_REL`, env `NOTESD_SWARM_SCRIPT`.
- `src/http/sessionsApi.ts`: `SessionsApiOptions` becomes `interface SessionsApiOptions extends SessionsReadOverrides { unfinished?: UnfinishedChecker }` (Phase 7 had `type SessionsApiOptions = SessionsReadOverrides`).
- `src/http/app.ts`: option `CreateAppOptions.unfinished?: UnfinishedChecker`.
- `web/src/components/graph/UnfinishedBadge.tsx`: `UnfinishedBadgeSvg`, `UnfinishedPill`,
  `UNFINISHED_TIP`; `web/src/components/graph/UnfinishedBadge.css`.
- `web/src/sessionDetailApi.ts` (Phase 11): `SessionDetail.unfinished: boolean | null`.
**Signature changes:** none beyond the additive option fields above.
**Requires (from earlier phases):**
- Phase 3: `config.sessions` exists as `SessionsConfig { claudeHome, worktreesDir, enabled }`,
  parsed by a `parseSessions(env)` helper in `src/config.ts`, and a `DEFAULT_SESSIONS_CONFIG`
  test literal exported next to `DEFAULT_CHAT_CONFIG`. `host` on rows is `os.hostname()`.
- Phase 7 (as published): `src/http/sessionsApi.ts` exports
  `sessionsApiRoutes(deps, options: SessionsApiOptions = {})` with `type SessionsApiOptions = SessionsReadOverrides`
  and `const rd = sessionsReadDeps(deps, options)` (`rd.host` = this host). The graph handler builds
  `payload: GraphPayload` via `graphForRepo`, computes `graphEtag(payload)` (the hash covers `nodes`,
  so `unfinished` must be set before it), then answers 304 or the payload; the detail handler returns
  `SessionDetail` (`detail.session` is the node). Wire nodes are snake_case `GraphNode`s carrying
  `name`, `custom_title`, `host`, `cwd`, `repo`, `live` and `unfinished: null`.
- Phase 9 (as published): `src/http/app.ts` has `CreateAppOptions { chat?, reveal?, sessions?, sessionResume? }`
  and mounts `app.route('/', sessionsApiRoutes(deps, options.sessions));` then
  `app.route('/', sessionResumeRoutes(deps, { resumer: sessionResume }));` before `staticRoutes`.
- Phase 10 (as published): `web/src/types.ts` `SessionNode.unfinished: boolean | null`;
  `ProjectsPage` takes `renderBadge?: (node: SessionNode) => ReactNode` and passes it to
  `<SessionGraph ... renderBadge={renderBadge} />`; `GraphNode` draws a non-null badge in a
  `<g className="gnode-badge">` translated to (badge column x, row centre y) and reserves
  `BADGE_W = 92` px only when the badge is not null/false.
- Phase 11 (as published): `web/src/sessionDetailApi.ts` `normalizeSessionDetail(raw)` (`w` = `raw.session`)
  and `NodePanel.tsx`'s header `<div className="np-meta">` whose first child is
  `{detail.live && <span className="np-live">running</span>}`.
- Phase 12 (as published): `ProjectsPage.tsx` as Phase 12 Step 15 leaves it (the
  `content = <SessionGraph ... renderBadge={renderBadge} />` line is unchanged by Phase 12).
**Leaves alone (owned by others):** the chat code (`src/chat/*`, `ChatBar`, Phase 12 project chat),
graph layout (`web/src/lib/sessionGraph.ts`, lanes, virtualization: Phase 10), `registry.ts`
(Phase 3), the rest of `NodePanel` (Phase 11), the swarm script itself (`~/claude-commands`, Phase 2),
README / CHANGELOG / env-var table (Phase 14).

## Files

| File | Action | What changes |
|---|---|---|
| `src/config.ts` (`SessionsConfig` + `parseSessions`, added by Phase 3 near `:65` / before `loadConfig` `:218`) | modify | `swarmScript` field from `NOTESD_SWARM_SCRIPT`, default `<claudeHome>/skills/swarm/swarm.py`; `DEFAULT_SESSIONS_CONFIG.swarmScript = null` |
| `src/sessions/unfinished.ts` | create | runner, verify parser, cached checker, `annotate` |
| `src/http/sessionsApi.ts` (Phase 7) | modify | `SessionsApiOptions.unfinished`; one checker per router; annotate graph nodes before the ETag and the detail's `session` |
| `src/http/app.ts` (as Phase 9 leaves it) | modify | `CreateAppOptions.unfinished`; pass it to `sessionsApiRoutes` |
| `web/src/components/graph/UnfinishedBadge.tsx` | create | SVG badge + HTML pill, both render nothing unless `unfinished === true` |
| `web/src/components/graph/UnfinishedBadge.css` | create | badge styling with existing tokens |
| `web/src/pages/ProjectsPage.tsx` (as Phase 12 leaves it) | modify | default `renderBadge` draws `UnfinishedBadgeSvg` for `unfinished === true` |
| `web/src/sessionDetailApi.ts` (Phase 11) | modify | `SessionDetail.unfinished` read from `session.unfinished` |
| `web/src/components/graph/NodePanel.tsx` (Phase 11) | modify | render `UnfinishedPill` in `.np-meta` |
| `tests/unit/sessions/unfinished.test.ts` | create | parser, slug, checker with fake runner and clock |
| `tests/unit/config.test.ts` | modify | default + override + blank of `NOTESD_SWARM_SCRIPT`; Phase 3's two whole-object `sessions` expectations gain `swarmScript` |
| `tests/integration/sessions.ingest.int.test.ts` (Phase 3) | modify | hand-built `sessions` literal gains `swarmScript: null` |
| `tests/integration/sessions.unfinished.int.test.ts` | create | both endpoints fill `unfinished` with an injected fake checker runner |
| `web/src/components/graph/UnfinishedBadge.test.tsx` | create | jsdom: badge only for `true` |

## Implementation Steps

### Step 1: `swarmScript` in the sessions config
**File:** `src/config.ts`, the `SessionsConfig` interface and `parseSessions` that Phase 3 adds
(between `EmbeddingsConfig` `:57` and `Config` `:65`, and above `loadConfig` `:218`).
**Change:** add one field and compute it from `NOTESD_SWARM_SCRIPT`. The default is derived from
`claudeHome`, so `CLAUDE_HOME=/tmp/x` in a test also moves the script away from the real one, and
with `CLAUDE_HOME` unset it is exactly `~/.claude/skills/swarm/swarm.py`. The config never touches
the file system for it: a missing file is the checker's business (Step 2), so installing the swarm
skill later needs no daemon config change. `DEFAULT_SESSIONS_CONFIG` (the test literal) gets
`swarmScript: null`, so no test app ever runs the real script.
**Code** (the interface and helpers as they read after this step; keep Phase 3's existing lines
for `claudeHome`, `worktreesDir`, `enabled` exactly as Phase 3 wrote them if they differ in form,
and add only the `swarmScript` lines):
```ts
/** Relative to `claudeHome`: where the swarm skill installs its script (`install.sh` in ~/claude-commands). */
export const DEFAULT_SWARM_SCRIPT_REL = path.join('skills', 'swarm', 'swarm.py')

/** Claude Code session ingest (phase 3) and the orch "unfinished" badge (phase 13). */
export interface SessionsConfig {
  /** `CLAUDE_HOME`, default ~/.claude. Absolute. */
  claudeHome: string
  /** `NOTES_WORKTREES_DIR`, default ~/.worktrees. Absolute. */
  worktreesDir: string
  /** False when `NOTESD_SESSIONS=off`: no ingest. */
  enabled: boolean
  /**
   * `NOTESD_SWARM_SCRIPT`, default `<claudeHome>/skills/swarm/swarm.py`. Absolute. Not checked here:
   * a missing file makes every orch node's `unfinished` null, never an error. Null turns the
   * check off (the test literal `DEFAULT_SESSIONS_CONFIG` uses null).
   */
  swarmScript: string | null
}

function parseSwarmScript(raw: string | undefined, claudeHome: string): string {
  const value = raw?.trim() ?? ''
  if (value === '') return path.join(claudeHome, DEFAULT_SWARM_SCRIPT_REL)
  return path.resolve(expandHome(value))
}
```
Inside `parseSessions(env)`, after Phase 3 computes `claudeHome`, add the field to the returned
object:
```ts
    swarmScript: parseSwarmScript(env.NOTESD_SWARM_SCRIPT, claudeHome),
```
In `DEFAULT_SESSIONS_CONFIG` add:
```ts
  swarmScript: null,
```
Update the doc comment of `loadConfig` (`:208-217`) by appending `NOTESD_SWARM_SCRIPT` to the
list of sessions keys Phase 3 added there.
**Impact:** `Config` literals built from `DEFAULT_SESSIONS_CONFIG` keep compiling. The one
hand-built `sessions: {...}` literal (Phase 3's `tests/integration/sessions.ingest.int.test.ts`)
gets `swarmScript: null` in Step 9.

### Step 2: `src/sessions/unfinished.ts`
**File:** `src/sessions/unfinished.ts` (new)
**Change:** the whole feature on the server, independent of HTTP so it is unit-testable.
**Code:**
```ts
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
      const firstTime: Promise<boolean | null>[] = [];
      for (const node of orch) {
        // Owning host only: the other machine's cwd means nothing here, and its daemon answers for it.
        if (node.host !== host) continue;
        const ref = ledgerRef(node);
        if (!ref) continue;
        refs.set(node, ref);
        const hit = cache.get(ref.key);
        if (hit && now() - hit.at < ttlMs) continue;
        const run = refresh(ref, script);
        if (!hit) firstTime.push(run);
      }

      await waitAtMost(firstTime, waitMs);

      for (const node of orch) {
        const ref = refs.get(node);
        const pending = ref ? (cache.get(ref.key)?.value ?? null) : null;
        node.unfinished = pending === null ? null : pending && !node.live;
      }
      return nodes;
    },
  };
}
```
**Impact:** new module, nothing imports it yet.

### Step 3: Fill `unfinished` in the read API
**File:** `src/http/sessionsApi.ts` as Phase 7 Step 4 wrote it.
**Change:** one checker per router instance (the cache must outlive a request, and one
`createApp` builds one router), injected for tests. The graph handler annotates before the ETag is
computed (so a badge change invalidates the 304); the detail handler annotates `detail.session`.
Phase 7's mapper that sets `unfinished: null` stays: null is the right value for every non-orch
node and for an orch node when the check cannot run. (The MCP `session_get` tool is not annotated:
its `unfinished` stays null.)
**Code:**
Imports (add):
```ts
import { createUnfinishedChecker, type UnfinishedChecker } from '../sessions/unfinished.js';
```
Replace Phase 7's `export type SessionsApiOptions = SessionsReadOverrides;` with:
```ts
export interface SessionsApiOptions extends SessionsReadOverrides {
  /** The orch "unfinished" check (phase 13). Omitted: built from config.sessions.swarmScript. */
  unfinished?: UnfinishedChecker;
}
```
Right after Phase 7's `const rd = sessionsReadDeps(deps, options);`:
```ts
  const unfinished =
    options.unfinished ?? createUnfinishedChecker({ swarmScript: deps.config.sessions?.swarmScript ?? null, host: rd.host });
```
The graph handler, after this phase:
```ts
  r.get('/api/projects/:repo/sessions', async (c) => {
    const repo = c.req.param('repo');
    const parsed = graphQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    const payload = await graphForRepo(rd, repo, { before: parsed.data.before ?? null, limit: parsed.data.limit });
    if (payload.total === 0) return c.json({ error: 'unknown_repo', repo }, 404);
    await unfinished.annotate(payload.nodes);
    const etag = graphEtag(payload);
    c.header('ETag', etag);
    c.header('Cache-Control', 'no-cache');
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    return c.json(payload);
  });
```
The detail handler, after this phase:
```ts
  r.get('/api/sessions/:nodeId', async (c) => {
    const nodeId = normalizeNodeId(c.req.param('nodeId'));
    if (nodeId === null) return c.json({ error: 'invalid_node_id' }, 400);
    const detail = await sessionDetail(rd, nodeId);
    if (detail === null) return c.json({ error: 'not_found', node_id: nodeId }, 404);
    await unfinished.annotate([detail.session]);
    return c.json(detail);
  });
```
**Impact:** the graph request may now wait up to `UNFINISHED_WAIT_MS` (1 s) the first time a repo
with never-checked orch nodes is opened; every later request within the TTL is a map lookup.
No change to the response shape.

### Step 4: Thread the option through `createApp`
**File:** `src/http/app.ts` as Phase 9 Step 5 leaves it.
**Change:** tests inject a checker with a fake runner the same way `reveal` is injected.
**Code:**
Import (add, next to Phase 7's `sessionsApiRoutes` import):
```ts
import type { UnfinishedChecker } from '../sessions/unfinished.js';
```
Field in `CreateAppOptions`, after Phase 9's `sessionResume?`:
```ts
  /** The orch "unfinished" check behind the sessions read API. Omitted: swarm.py from config. */
  unfinished?: UnfinishedChecker;
```
Replace Phase 7's mount line `app.route('/', sessionsApiRoutes(deps, options.sessions));` with:
```ts
  app.route('/', sessionsApiRoutes(deps, { ...options.sessions, unfinished: options.unfinished }));
```
**Impact:** none for existing callers (the option is optional).

### Step 5: Badge components
**File:** `web/src/components/graph/UnfinishedBadge.tsx` (new)
**Change:** two presentations of one fact. The graph is SVG, so the graph badge is SVG; the
panel header is HTML. Both render nothing unless the value is exactly `true` (null = unknown is
not shown). Text label "unfinished" is what the brief names; the hourglass icon carries it at a glance.
**Code:**
```tsx
import { HourglassMedium } from '@phosphor-icons/react';
import './UnfinishedBadge.css';

/** Hover text for both badges. */
export const UNFINISHED_TIP = 'Swarm ledger still has pending phases and no session is running it';

const LABEL = 'unfinished';
/** Width of the SVG pill: icon (10) + gaps + 10 chars of 9px Geist Mono. */
const PILL_W = 78;
const PILL_H = 14;

/** Graph node badge (SVG). Top-left corner at (x, y) inside GraphNode's badge slot. */
export function UnfinishedBadgeSvg({ unfinished, x, y }: { unfinished: boolean | null | undefined; x: number; y: number }) {
  if (unfinished !== true) return null;
  return (
    <g className="gnode-unfinished" transform={`translate(${x} ${y})`} data-testid="unfinished-badge" role="img" aria-label={LABEL}>
      <title>{UNFINISHED_TIP}</title>
      <rect className="gnode-unfinished-bg" width={PILL_W} height={PILL_H} rx={PILL_H / 2} ry={PILL_H / 2} />
      <HourglassMedium x={4} y={2} width={10} height={10} weight="bold" aria-hidden="true" />
      <text className="gnode-unfinished-text" x={17} y={PILL_H / 2} dominantBaseline="central">
        {LABEL}
      </text>
    </g>
  );
}

/** Node panel header pill (HTML). */
export function UnfinishedPill({ unfinished }: { unfinished: boolean | null | undefined }) {
  if (unfinished !== true) return null;
  return (
    <span className="unfinished-pill" data-tip={UNFINISHED_TIP} title={UNFINISHED_TIP} data-testid="unfinished-pill">
      <HourglassMedium size={12} weight="bold" aria-hidden="true" />
      {LABEL}
    </span>
  );
}
```

**File:** `web/src/components/graph/UnfinishedBadge.css` (new)
**Code:**
```css
/* The orch "unfinished" badge (phase 13). Uses the wall's tokens; amber is the one accent,
   so a finished graph stays monochrome and an open set is visible from across the page. */
.gnode-unfinished { pointer-events: auto; }
.gnode-unfinished-bg { fill: rgba(232, 176, 74, .16); stroke: rgba(232, 176, 74, .55); stroke-width: 1; }
.gnode-unfinished svg { color: #e8b04a; }
.gnode-unfinished-text { fill: #e8b04a; font: 500 9px/1 var(--mono); letter-spacing: .02em; }

.unfinished-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border: 1px solid rgba(232, 176, 74, .55);
  border-radius: 999px;
  background: rgba(232, 176, 74, .12);
  color: #e8b04a;
  font: 500 11px/1.4 var(--mono);
  white-space: nowrap;
}
```
**Impact:** none until mounted.

### Step 6: Default the badge slot in ProjectsPage
**File:** `web/src/pages/ProjectsPage.tsx` as Phase 12 leaves it. `GraphNode.tsx` is not edited:
Phase 10's `renderBadge` slot is the mount point.
**Change:** one import, one default, one prop swap. The default returns `null` for every node that
is not `unfinished === true`, so Phase 10 reserves no `BADGE_W` column for them.
**Code:**
```tsx
import { UnfinishedBadgeSvg } from '../components/graph/UnfinishedBadge';
```
next to Phase 11's `panel` default:
```tsx
  const badge =
    renderBadge ?? ((n: SessionNode) => (n.unfinished === true ? <UnfinishedBadgeSvg unfinished x={0} y={-7} /> : null));
```
and in the `content = <SessionGraph ... />` line replace `renderBadge={renderBadge}` with `renderBadge={badge}`.
The slot `<g>` is already translated to the row centre, so `y={-7}` centres the 14 px pill.
**Impact:** an orch node with `unfinished: true` grows a pill right of its id; virtualization is
unaffected (the badge is inside the node's own `<g>`).

### Step 7: The pill in the NodePanel header
**Files:** `web/src/sessionDetailApi.ts` and `web/src/components/graph/NodePanel.tsx` (Phase 11).
**Change (a), `sessionDetailApi.ts`:** add to the `SessionDetail` interface, after `live: boolean;`:
```ts
  /** Phase 13: orch node with pending ledger phases and no live session; null = unknown / not orch. */
  unfinished: boolean | null;
```
and to the object `normalizeSessionDetail` returns, after `live: w.live === true,`:
```ts
    unfinished: typeof w.unfinished === 'boolean' ? w.unfinished : null,
```
(Phase 11's tests compare single fields, not whole objects, so they stay green.)
**Change (b), `NodePanel.tsx`:** import, and the pill as the first child of `.np-meta`, before
Phase 11's `{detail.live && <span className="np-live">running</span>}`:
```tsx
import { UnfinishedPill } from './UnfinishedBadge';
```
```tsx
            <UnfinishedPill unfinished={detail.unfinished} />
```
**Impact:** none for non-orch nodes.

### Step 8: Unit tests for the checker
**File:** `tests/unit/sessions/unfinished.test.ts` (new)
**Code:**
```ts
import { describe, expect, it, vi } from 'vitest';
import {
  createUnfinishedChecker,
  orchSlug,
  parseVerifyOutput,
  type SwarmRunner,
  type SwarmRunRequest,
  type UnfinishedTarget,
} from '../../../src/sessions/unfinished.js';

const HOST = 'lenovo';
const HOME = '/home/u';
const SCRIPT = '/home/u/.claude/skills/swarm/swarm.py';

function verifyJson(statuses: Array<{ status: string; derived?: string }>): string {
  return JSON.stringify({
    swarm: true,
    slug: 's',
    disagreements: [],
    applied: false,
    runnable_now: [],
    stalled: [],
    phases: statuses.map((p, i) => ({ n: i + 1, title: `p${i + 1}`, commit: null, task_id: null, ...p })),
  });
}

function node(over: Partial<UnfinishedTarget> = {}): UnfinishedTarget {
  return {
    name: 'orch-wall-editing',
    custom_title: null,
    host: HOST,
    cwd: '/home/u/.worktrees/mcp-notes/wall-editing',
    repo: 'mcp-notes',
    live: false,
    unfinished: null,
    ...over,
  };
}

function fakeRunner(stdout: string | ((req: SwarmRunRequest) => string)) {
  return vi.fn<SwarmRunner>(async (req) => ({ code: 0, stdout: typeof stdout === 'string' ? stdout : stdout(req) }));
}

function checker(runner: SwarmRunner, over: { exists?: Set<string>; now?: () => number; waitMs?: number; swarmScript?: string | null } = {}) {
  const present = over.exists ?? new Set([SCRIPT, '/home/u/.worktrees/mcp-notes/wall-editing', '/home/u/mcp-notes']);
  return createUnfinishedChecker({
    swarmScript: over.swarmScript === undefined ? SCRIPT : over.swarmScript,
    host: HOST,
    homeDir: HOME,
    runner,
    exists: (p) => present.has(p),
    now: over.now ?? (() => 0),
    waitMs: over.waitMs ?? 200,
  });
}

describe('orchSlug', () => {
  it('takes the slug off an orch name', () => {
    expect(orchSlug('orch-wall-editing')).toBe('wall-editing');
    expect(orchSlug('orch-project-session-graph')).toBe('project-session-graph');
  });
  it('rejects everything else', () => {
    expect(orchSlug('impl-wall-editing-p3')).toBeNull();
    expect(orchSlug('analyze-wall-editing')).toBeNull();
    expect(orchSlug('orch-')).toBeNull();
    expect(orchSlug('orch-a b')).toBeNull();
    expect(orchSlug('orch-../x')).toBeNull();
    expect(orchSlug(null)).toBeNull();
  });
});

describe('parseVerifyOutput', () => {
  it('is true when any phase is not derived done', () => {
    expect(parseVerifyOutput(verifyJson([{ status: 'done', derived: 'done' }, { status: 'pending', derived: 'pending' }]))).toBe(true);
    expect(parseVerifyOutput(verifyJson([{ status: 'done', derived: 'done' }, { status: 'failed', derived: 'failed' }]))).toBe(true);
  });
  it('trusts derived over the ledger status', () => {
    expect(parseVerifyOutput(verifyJson([{ status: 'running', derived: 'done' }]))).toBe(false);
    expect(parseVerifyOutput(verifyJson([{ status: 'done', derived: 'pending' }]))).toBe(true);
  });
  it('falls back to status when derived is missing', () => {
    expect(parseVerifyOutput(verifyJson([{ status: 'done' }]))).toBe(false);
    expect(parseVerifyOutput(verifyJson([{ status: 'running' }]))).toBe(true);
  });
  it('is false when every phase is done or there are none', () => {
    expect(parseVerifyOutput(verifyJson([{ status: 'done', derived: 'done' }]))).toBe(false);
    expect(parseVerifyOutput(verifyJson([]))).toBe(false);
  });
  it('is false for a repo with no ledger for the slug', () => {
    expect(parseVerifyOutput(JSON.stringify({ swarm: false, reason: 'no ledger for x', repo: '/home/u/mcp-notes' }))).toBe(false);
  });
  it('is null when swarm.py found no repo, or the output is not what it prints', () => {
    expect(parseVerifyOutput(JSON.stringify({ swarm: false, reason: 'not inside a git repository' }))).toBeNull();
    expect(parseVerifyOutput('Traceback (most recent call last):')).toBeNull();
    expect(parseVerifyOutput('[]')).toBeNull();
    expect(parseVerifyOutput(JSON.stringify({ swarm: true }))).toBeNull();
  });
});

describe('createUnfinishedChecker.annotate', () => {
  const PENDING = verifyJson([{ status: 'done', derived: 'done' }, { status: 'pending', derived: 'pending' }]);
  const DONE = verifyJson([{ status: 'done', derived: 'done' }]);

  it('marks an orch node with pending phases and no live session', async () => {
    const runner = fakeRunner(PENDING);
    const [n] = await checker(runner).annotate([node()]);
    expect(n!.unfinished).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]![0]).toMatchObject({
      script: SCRIPT,
      slug: 'wall-editing',
      cwd: '/home/u/.worktrees/mcp-notes/wall-editing',
    });
  });

  it('is false while the orch session is live', async () => {
    const [n] = await checker(fakeRunner(PENDING)).annotate([node({ live: true })]);
    expect(n!.unfinished).toBe(false);
  });

  it('is false when the ledger is finished', async () => {
    const [n] = await checker(fakeRunner(DONE)).annotate([node()]);
    expect(n!.unfinished).toBe(false);
  });

  it('reads the orch name from the custom title too', async () => {
    const [n] = await checker(fakeRunner(PENDING)).annotate([node({ name: null, custom_title: 'orch-wall-editing' })]);
    expect(n!.unfinished).toBe(true);
  });

  it('never runs for a non-orch node and leaves it null', async () => {
    const runner = fakeRunner(PENDING);
    const [n] = await checker(runner).annotate([node({ name: 'impl-wall-editing-p3' })]);
    expect(n!.unfinished).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it('never runs for a node on the other machine', async () => {
    const runner = fakeRunner(PENDING);
    const [n] = await checker(runner).annotate([node({ host: 'gpd' })]);
    expect(n!.unfinished).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it('is null, without running anything, when the script is missing or turned off', async () => {
    const runner = fakeRunner(PENDING);
    const missing = new Set(['/home/u/.worktrees/mcp-notes/wall-editing']);
    expect((await checker(runner, { exists: missing }).annotate([node()]))[0]!.unfinished).toBeNull();
    expect((await checker(runner, { swarmScript: null }).annotate([node()]))[0]!.unfinished).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it('falls back to ~/<repo> when the worktree is gone, and gives up when neither exists', async () => {
    const runner = fakeRunner(PENDING);
    const gone = new Set([SCRIPT, '/home/u/mcp-notes']);
    await checker(runner, { exists: gone }).annotate([node()]);
    expect(runner.mock.calls[0]![0].cwd).toBe('/home/u/mcp-notes');

    const nothing = fakeRunner(PENDING);
    const [n] = await checker(nothing, { exists: new Set([SCRIPT]) }).annotate([node()]);
    expect(n!.unfinished).toBeNull();
    expect(nothing).not.toHaveBeenCalled();
  });

  it('ignores a repo key that is not a plain directory name', async () => {
    const runner = fakeRunner(PENDING);
    const [n] = await checker(runner, { exists: new Set([SCRIPT, '/home/x']) }).annotate([
      node({ cwd: null, repo: '../x' }),
    ]);
    expect(n!.unfinished).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it('is null when swarm.py fails, exits non-zero or throws', async () => {
    const bad = vi.fn<SwarmRunner>(async () => ({ code: 2, stdout: PENDING }));
    expect((await checker(bad).annotate([node()]))[0]!.unfinished).toBeNull();
    const boom = vi.fn<SwarmRunner>(async () => {
      throw new Error('spawn python3 ENOENT');
    });
    expect((await checker(boom).annotate([node()]))[0]!.unfinished).toBeNull();
  });

  it('caches per slug for the TTL, then serves the stale value while it refreshes', async () => {
    let t = 0;
    let out = PENDING;
    const runner = fakeRunner(() => out);
    const c = checker(runner, { now: () => t });

    expect((await c.annotate([node()]))[0]!.unfinished).toBe(true);
    t = 30_000;
    expect((await c.annotate([node()]))[0]!.unfinished).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);

    out = DONE;
    t = 61_000;
    // Stale: answered from the cache at once, refresh started in the background.
    expect((await c.annotate([node()]))[0]!.unfinished).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => {
      expect((await c.annotate([node()]))[0]!.unfinished).toBe(false);
    });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('runs once for two nodes of the same set', async () => {
    const runner = fakeRunner(PENDING);
    const nodes = await checker(runner).annotate([node(), node({ live: true })]);
    expect(nodes.map((n) => n.unfinished)).toEqual([true, false]);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('answers null when swarm.py is slower than the wait budget, and the value on the next call', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = vi.fn<SwarmRunner>(async () => {
      await gate;
      return { code: 0, stdout: PENDING };
    });
    const c = checker(runner, { waitMs: 10 });
    expect((await c.annotate([node()]))[0]!.unfinished).toBeNull();
    release();
    await vi.waitFor(async () => {
      expect((await c.annotate([node()]))[0]!.unfinished).toBe(true);
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('runs at most `concurrency` at a time', async () => {
    let active = 0;
    let peak = 0;
    const runner = vi.fn<SwarmRunner>(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return { code: 0, stdout: PENDING };
    });
    const c = createUnfinishedChecker({
      swarmScript: SCRIPT,
      host: HOST,
      homeDir: HOME,
      runner,
      exists: () => true,
      waitMs: 1_000,
      concurrency: 2,
    });
    const nodes = Array.from({ length: 6 }, (_, i) => node({ name: `orch-set-${i}` }));
    await c.annotate(nodes);
    expect(runner).toHaveBeenCalledTimes(6);
    expect(peak).toBe(2);
    expect(nodes.every((n) => n.unfinished === true)).toBe(true);
  });
});
```

### Step 9: Config tests
**File:** `tests/unit/config.test.ts`: the `applies defaults` expectation (`:28`) and a new `it`
next to Phase 3's sessions tests.
**Change:** two of Phase 3's expectations compare the whole `sessions` object and gain the field:
- in `it('applies defaults')`, Phase 3's line becomes
```ts
      sessions: { claudeHome: path.join(homedir(), '.claude'), worktreesDir: path.join(homedir(), '.worktrees'), enabled: true, swarmScript: path.join(homedir(), '.claude', 'skills', 'swarm', 'swarm.py') },
```
- in Phase 3's `describe('loadConfig sessions')` > `it('defaults to ~/.claude and ~/.worktrees, on')`, the `toEqual` object gains
```ts
      swarmScript: path.join(homedir(), '.claude', 'skills', 'swarm', 'swarm.py'),
```
Also `tests/integration/sessions.ingest.int.test.ts` (Phase 3 Step 15) builds
`sessions: { claudeHome: home, worktreesDir: FIXTURE.worktreesDir, enabled: true }` by hand; it
becomes `{ claudeHome: home, worktreesDir: FIXTURE.worktreesDir, enabled: true, swarmScript: null }`.
Those are the only hand-built `SessionsConfig` literals in the plan set (every other test spreads
`DEFAULT_SESSIONS_CONFIG`).
New test (inside `describe('loadConfig')`):
```ts
  it('reads NOTESD_SWARM_SCRIPT, defaulting under CLAUDE_HOME', () => {
    const home = loadConfig({ env: { DATABASE_URL: URL_A, CLAUDE_HOME: '/tmp/cc-home' }, envFile: false })
    expect(home.sessions.swarmScript).toBe('/tmp/cc-home/skills/swarm/swarm.py')

    const custom = loadConfig({ env: { DATABASE_URL: URL_A, NOTESD_SWARM_SCRIPT: '~/bin/swarm.py' }, envFile: false })
    expect(custom.sessions.swarmScript).toBe(path.join(homedir(), 'bin', 'swarm.py'))

    const blank = loadConfig({ env: { DATABASE_URL: URL_A, NOTESD_SWARM_SCRIPT: '  ' }, envFile: false })
    expect(blank.sessions.swarmScript).toBe(path.join(homedir(), '.claude', 'skills', 'swarm', 'swarm.py'))
  })

  it('does not require the swarm script to exist', () => {
    const cfg = loadConfig({ env: { DATABASE_URL: URL_A, NOTESD_SWARM_SCRIPT: '/nope/swarm.py' }, envFile: false })
    expect(cfg.sessions.swarmScript).toBe('/nope/swarm.py')
  })
```

### Step 10: Integration test through both endpoints
**File:** `tests/integration/sessions.unfinished.int.test.ts` (new)
**Change:** seeds three rows and checks the field end to end with a fake runner. Seeds through
Phase 1's `SessionsRepo.upsertFromHook` (returns `{ session, parent, parentLink }`) on
`startHarness` from `tests/integration/imageHarness.ts` (`{ deps, app, reset, close }`). The live
registry is overridden with an empty list through Phase 7's `CreateAppOptions.sessions` seam, so
the test never reads the real `~/.claude` (invariant 2).
**Code:**
```ts
import { hostname } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/http/app.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { createUnfinishedChecker, type SwarmRunner } from '../../src/sessions/unfinished.js';
import { startHarness, type Harness } from './imageHarness.js';

const PENDING = JSON.stringify({
  swarm: true,
  slug: 'demo',
  phases: [
    { n: 1, title: 'a', status: 'done', derived: 'done' },
    { n: 2, title: 'b', status: 'pending', derived: 'pending' },
  ],
});

interface WireNode {
  node_id: string;
  name: string | null;
  unfinished: boolean | null;
}

/** Phase 7 seam: nothing is live, and the real ~/.claude/sessions is never read. */
const NO_LIVE = { live: async () => [] };

describe('unfinished badge field', () => {
  let h: Harness;
  const runner = vi.fn<SwarmRunner>(async () => ({ code: 0, stdout: PENDING }));

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    runner.mockClear();
  });

  async function seed(sessionId: string, name: string, host: string): Promise<string> {
    const repo = new SessionsRepo(h.deps.db);
    const { session } = await repo.upsertFromHook({
      sessionId,
      parentSessionId: null,
      cwd: '/',
      name,
      tmux: null,
      host,
      startedAt: new Date('2026-11-01T00:00:00Z'),
      repo: 'demo-repo',
    });
    return session.nodeId;
  }

  function app() {
    return createApp(h.deps, {
      sessions: NO_LIVE,
      unfinished: createUnfinishedChecker({ swarmScript: '/', host: hostname(), runner, exists: () => true }),
    });
  }

  it('fills unfinished for orch nodes on this host only', async () => {
    await seed('00000000-0000-4000-8000-000000000001', 'orch-demo', hostname());
    await seed('00000000-0000-4000-8000-000000000002', 'impl-demo-p1', hostname());
    await seed('00000000-0000-4000-8000-000000000003', 'orch-demo', 'some-other-laptop');

    const res = await app().request('/api/projects/demo-repo/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: WireNode[] };
    const byHostName = body.nodes.map((n) => [n.name, n.unfinished]);
    expect(byHostName).toEqual(
      expect.arrayContaining([
        ['orch-demo', true],
        ['impl-demo-p1', null],
        ['orch-demo', null],
      ]),
    );
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('fills unfinished on the node detail', async () => {
    const nodeId = await seed('00000000-0000-4000-8000-000000000004', 'orch-demo', hostname());
    const res = await app().request(`/api/sessions/${nodeId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { unfinished: boolean | null } };
    expect(body.session.unfinished).toBe(true);
  });

  it('reports null when no swarm script is configured (default test config)', async () => {
    await seed('00000000-0000-4000-8000-000000000005', 'orch-demo', hostname());
    const res = await createApp(h.deps, { sessions: NO_LIVE }).request('/api/projects/demo-repo/sessions');
    const body = (await res.json()) as { nodes: WireNode[] };
    expect(body.nodes.find((n) => n.name === 'orch-demo')!.unfinished).toBeNull();
  });
});
```
Note on response shapes: if Phase 7's graph payload names the array differently from `nodes`, or
wraps the detail in `{ node }`, adjust the two `as` casts; the assertions do not change.

### Step 11: jsdom test for the badge
**File:** `web/src/components/graph/UnfinishedBadge.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { UNFINISHED_TIP, UnfinishedBadgeSvg, UnfinishedPill } from './UnfinishedBadge';

afterEach(() => {
  cleanup();
});

function inSvg(node: React.ReactNode) {
  return render(<svg>{node}</svg>);
}

describe('UnfinishedBadgeSvg', () => {
  it('renders only for unfinished === true', () => {
    for (const value of [null, false, undefined]) {
      inSvg(<UnfinishedBadgeSvg unfinished={value} x={0} y={0} />);
      expect(screen.queryByTestId('unfinished-badge')).toBeNull();
      cleanup();
    }
    inSvg(<UnfinishedBadgeSvg unfinished x={12} y={4} />);
    const badge = screen.getByTestId('unfinished-badge');
    expect(badge.getAttribute('transform')).toBe('translate(12 4)');
    expect(badge.textContent).toContain('unfinished');
    expect(badge.querySelector('title')?.textContent).toBe(UNFINISHED_TIP);
  });
});

describe('UnfinishedPill', () => {
  it('renders only for unfinished === true', () => {
    render(<UnfinishedPill unfinished={null} />);
    expect(screen.queryByTestId('unfinished-pill')).toBeNull();
    cleanup();
    render(<UnfinishedPill unfinished={false} />);
    expect(screen.queryByTestId('unfinished-pill')).toBeNull();
    cleanup();
    render(<UnfinishedPill unfinished />);
    const pill = screen.getByTestId('unfinished-pill');
    expect(pill.textContent).toBe('unfinished');
    expect(pill.getAttribute('data-tip')).toBe(UNFINISHED_TIP);
  });
});
```
If `React` is not in scope as a type namespace under the web tsconfig, replace
`React.ReactNode` with `import type { ReactNode } from 'react'` and use `ReactNode`.

Add one case to Phase 10's `GraphNode` test and Phase 11's `NodePanel` test if those files
exist, reusing their own node fixtures:
```tsx
  it('shows the unfinished badge for an orch node that the API marks unfinished', () => {
    renderNode({ ...fixtureNode, name: 'orch-demo', unfinished: true });
    expect(screen.getByTestId('unfinished-badge')).toBeTruthy();
  });
```
(`renderNode` / `fixtureNode` are the names those test files use for their render helper and
fixture; for NodePanel query `unfinished-pill`.)

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npx vitest run tests/unit/sessions/unfinished.test.ts tests/unit/config.test.ts web/src/components/graph/UnfinishedBadge.test.tsx`, then `npm test` and `npm run test:int`
**Manual check:** with the daemon rebuilt, open `/projects?repo=mcp-notes`. While this plan set is
in flight, the `orch-project-session-graph` node shows no badge while its session runs and shows
"unfinished" after that session exits (live registry entry gone) with phases still pending.
`curl -s localhost:7317/api/projects/mcp-notes/sessions | jq '.nodes[] | select(.name|startswith("orch-")) | {name, unfinished}'`
lists `false` for landed sets (wall-editing, connectors, ...). Rename the script
(`NOTESD_SWARM_SCRIPT=/nope`) and restart: every orch node reports `null`, no error in the log.
Time the first graph request on a cold daemon: it should be under ~1.2 s, later ones unchanged
from before this phase.
**Exit criteria:** fake-runner tests pass for every branch (orch/non-orch, host, live, script
missing, fallback dir, cache, stale refresh, budget, concurrency); the badge renders only when
`unfinished === true`; `npm test`, `npm run typecheck` and `npm run test:int` are green.

## Decisions taken in this plan

| Fork | Chosen | Why |
|---|---|---|
| `verify` vs `status` | `verify` | `status` trusts a ledger that says `running` forever after a crash; `verify` derives from git (and the brief names it). |
| "pending phases" | any phase whose effective status is not `done` | failed/blocked phases also leave the set unfinished; `derived` wins over `status`. |
| no ledger for the slug | `false` | nothing pending; an orch session that never ran `init` is not unfinished. |
| non-orch / other host / unknown | `null` | null is the reserved "no answer" value; the badge shows only `true`. |
| repo dir | session `cwd`, then `~/<repo>` | swarm.py walks a worktree to its main checkout itself; a deleted worktree needs the checkout. |
| swarm script default | `<claudeHome>/skills/swarm/swarm.py` | equals `~/.claude/skills/swarm/swarm.py` by default and follows `CLAUDE_HOME` in tests (invariant 2). |
| test default | `DEFAULT_SESSIONS_CONFIG.swarmScript = null` | no test app ever runs the real swarm.py. |
| latency | 60 s TTL, stale-while-revalidate, 1 s first-answer budget, 4 concurrent | measured 0.04-0.11 s per slug; keeps the graph endpoint fast with dozens of orch nodes. |
| run `verify --apply` | never | the badge is a read; writing ledgers is the orchestrator's job. |

## Handoffs

- **Phase 14 (docs):** add `NOTESD_SWARM_SCRIPT` (default `~/.claude/skills/swarm/swarm.py`,
  missing file disables the badge) to the README env-var table, describe the "unfinished" badge
  and the `unfinished` field (`true | false | null`) of `GET /api/projects/:repo/sessions` and
  `GET /api/sessions/:nodeId`, and note it is answered only by the daemon on the node's host.
- **Phase 7 / 10 / 11 (reconciled):** bound to their published shapes: snake_case `GraphNode`
  (`name`, `custom_title`, `cwd`, `repo`, `live`, `host`), `SessionsApiOptions`, Phase 10's
  `renderBadge` slot and Phase 11's `.np-meta` header.
- Not done here, possible follow-up: MCP `session_get` could also report `unfinished`. That would
  serve R6, which this phase does not own; left out deliberately.

## Rollback

Revert this phase's commit. It adds one module, two components, one CSS file, tests, one optional
config field and two optional options; no schema or migration. After the revert the API returns
`unfinished: null` again (Phase 7's placeholder) and the web renders no badge.
